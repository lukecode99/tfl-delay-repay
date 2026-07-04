// Eligibility engine tests — run with:
//   node --experimental-strip-types src/eligibility/test-eligibility.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessJourney, isPeak, londonToUtcMs, thresholdForTiming } from './engine.ts';
import type { DisruptionLookup, LedgerStatus } from './engine.ts';
import { expectedTiming, parseJourneyResults } from './planner.ts';
import { makeResolver, normalizeStationName } from './resolve-core.ts';
import { makeSnapshotLookup } from './ledger-json.ts';
import type { LedgerSnapshot } from './ledger-json.ts';
import { claimDeadline } from './deadline.ts';
import { formatDay, groupByDay } from '../format.ts';
import type { ParsedJourney } from '../journeys/parse';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- planner ----------------------------------------------------------------
const PLANNER_FIXTURE = {
  journeys: [
    {
      duration: 31,
      legs: [{ mode: { id: 'elizabeth-line' }, routeOptions: [{ lineIdentifier: { id: 'elizabeth' } }] }],
    },
    {
      duration: 24,
      legs: [
        { mode: { id: 'walking' }, routeOptions: [{ lineIdentifier: { id: 'should-not-appear' } }] },
        {
          mode: { id: 'tube' },
          routeOptions: [{ lineIdentifier: { id: 'metropolitan' } }, { lineIdentifier: { id: 'jubilee' } }],
        },
      ],
    },
  ],
};
{
  const t = parseJourneyResults(PLANNER_FIXTURE, '2026-06-10T00:00:00Z')!;
  ok(t.expectedMinutes === 24, 'planner: expected = fastest route duration');
  ok(t.routes[0].modes.join() === 'tube', 'planner: routes sorted fastest first, walking legs skipped');
  ok(t.plausibleLines.sort().join() === 'elizabeth,jubilee,metropolitan', 'planner: plausible lines are the union across routes');
  ok(!t.plausibleLines.includes('should-not-appear'), 'planner: walking-leg routeOptions ignored');
  ok(parseJourneyResults({ disambiguation: {} }, 'x') === null, 'planner: disambiguation response → null');
}
{
  let calls = 0;
  const cache = new Map<string, any>();
  const fetchJson = async () => { calls++; return PLANNER_FIXTURE; };
  const opts = { fetchJson, cache: { get: (k: string) => cache.get(k), set: (k: string, v: any) => cache.set(k, v) } };
  await expectedTiming('A', 'B', opts);
  const second = await expectedTiming('A', 'B', opts);
  ok(calls === 1 && second?.expectedMinutes === 24, 'planner: second lookup served from cache (1 fetch)');
}

// --- time & fare helpers ------------------------------------------------------
ok(londonToUtcMs('2026-01-15', '09:00') === Date.UTC(2026, 0, 15, 9, 0), 'time: January 09:00 London = 09:00 UTC (GMT)');
ok(londonToUtcMs('2026-07-04', '09:00') === Date.UTC(2026, 6, 4, 8, 0), 'time: July 09:00 London = 08:00 UTC (BST)');
ok(londonToUtcMs('2026-03-29', '00:30') === Date.UTC(2026, 2, 29, 0, 30), 'time: before 01:00 on BST-start Sunday still GMT');
ok(londonToUtcMs('2026-03-29', '02:00') === Date.UTC(2026, 2, 29, 1, 0), 'time: after springforward on BST-start Sunday is BST');

ok(isPeak('2026-06-10', '08:00'), 'fare: weekday 08:00 is peak');
ok(!isPeak('2026-06-10', '12:00'), 'fare: weekday midday is off-peak');
ok(isPeak('2026-06-10', '16:00'), 'fare: weekday 16:00 is peak');
ok(!isPeak('2026-06-10', '19:00'), 'fare: 19:00 is off-peak (peak ends at 19:00)');
ok(!isPeak('2026-07-04', '08:00'), 'fare: Saturday morning is off-peak');

// --- thresholds ----------------------------------------------------------------
const TUBE_TIMING = parseJourneyResults(PLANNER_FIXTURE, 'x')!; // fastest = tube
const LIZZIE_TIMING = parseJourneyResults({
  journeys: [{ duration: 20, legs: [{ mode: { id: 'elizabeth-line' }, routeOptions: [{ lineIdentifier: { id: 'elizabeth' } }] }] }],
}, 'x')!;
ok(thresholdForTiming(TUBE_TIMING) === 15, 'threshold: tube/DLR fastest route → 15 min');
ok(thresholdForTiming(LIZZIE_TIMING) === 30, 'threshold: Elizabeth line fastest route → 30 min');

// --- assessJourney ---------------------------------------------------------------
function mkJourney(over: Partial<ParsedJourney> = {}): ParsedJourney {
  return {
    card: 'test', date: '2026-06-10', tapInTime: '08:00', tapOutTime: '08:55',
    origin: 'Finchley Road', destination: 'Bank', charge: 3.1, incomplete: false,
    rawAction: 'Finchley Road to Bank', ...over,
  };
}
// tap-in 08:00 BST = 07:00Z; tap-out 08:55 BST = 07:55Z. Expected 24 → actual 55, overage 31.
function ledger(rows: LedgerStatus[], coverage = 5): DisruptionLookup {
  return (lines, fromISO, toISO) => ({
    coverage,
    statuses: rows.filter(r => lines.includes(r.line) && r.ts >= fromISO && r.ts <= toISO),
  });
}
const severeDuring: LedgerStatus = {
  ts: '2026-06-10T07:15:00.000Z', line: 'metropolitan', statusSeverity: 6,
  statusDescription: 'Severe Delays', reason: 'Signal failure at Baker Street',
};
const minorDuring: LedgerStatus = { ...severeDuring, statusSeverity: 9, statusDescription: 'Minor Delays' };
const severeEarlier: LedgerStatus = { ...severeDuring, ts: '2026-06-10T05:30:00.000Z' };

{
  const a = assessJourney({ journey: mkJourney(), timing: TUBE_TIMING, lookup: ledger([severeDuring]) });
  ok(a.status === 'eligible' && a.confidence === 'high', 'assess: severe delay during window → eligible/high');
  ok(a.overageMinutes === 31 && a.thresholdMinutes === 15, 'assess: overage 31 vs threshold 15');
  ok(a.disruption?.reason === 'Signal failure at Baker Street', 'assess: disruption reason attached');
  ok(a.refundValue === 3.1, 'assess: refund = CSV charge');
}
{
  const a = assessJourney({ journey: mkJourney(), timing: TUBE_TIMING, lookup: ledger([minorDuring]) });
  ok(a.status === 'eligible' && a.confidence === 'medium', 'assess: only Minor Delays during window → medium');
}
{
  const a = assessJourney({ journey: mkJourney(), timing: TUBE_TIMING, lookup: ledger([severeEarlier]) });
  ok(a.status === 'eligible' && a.confidence === 'medium', 'assess: severe delay 1.5h before tap-in → medium');
}
{
  const a = assessJourney({ journey: mkJourney(), timing: TUBE_TIMING, lookup: ledger([], 0) });
  ok(a.status === 'eligible' && a.confidence === 'low', 'assess: collector gap (no coverage) → eligible/low');
}
{
  const a = assessJourney({ journey: mkJourney(), timing: TUBE_TIMING, lookup: ledger([], 5) });
  ok(a.status === 'not-eligible' && a.reasonCode === 'no-disruption', 'assess: healthy lines with coverage → not eligible');
}
{
  const a = assessJourney({ journey: mkJourney({ tapOutTime: '08:30' }), timing: TUBE_TIMING, lookup: ledger([severeDuring]) });
  ok(a.status === 'not-eligible' && a.reasonCode === 'under-threshold', 'assess: 6 min overage → under threshold');
}
{
  const j = mkJourney({ tapOutTime: '08:45' }); // 45 actual vs 20 expected = 25 overage
  const a = assessJourney({ journey: j, timing: LIZZIE_TIMING, lookup: ledger([{ ...severeDuring, line: 'elizabeth' }]) });
  ok(a.status === 'not-eligible' && a.reasonCode === 'under-threshold', 'assess: 25 min overage on Elizabeth line < 30 threshold');
}
{
  const a = assessJourney({ journey: mkJourney({ tapOutTime: null, destination: null, incomplete: true }), timing: TUBE_TIMING, lookup: ledger([]) });
  ok(a.status === 'not-assessable' && a.reasonCode === 'incomplete', 'assess: incomplete journey → not assessable');
}
{
  const a = assessJourney({ journey: mkJourney(), timing: null, lookup: ledger([]) });
  ok(a.status === 'not-assessable' && a.reasonCode === 'no-timing', 'assess: unroutable pair → not assessable');
}
{
  const est = { peak: 3.1, offPeak: 3.0 };
  const peak = assessJourney({ journey: mkJourney({ charge: null }), timing: TUBE_TIMING, lookup: ledger([severeDuring]), fareEstimate: est });
  const off = assessJourney({ journey: mkJourney({ charge: null, tapInTime: '12:00', tapOutTime: '12:55' }), timing: TUBE_TIMING, lookup: ledger([]), fareEstimate: est });
  ok(peak.refundValue === 3.1 && off.refundValue === 3.0, 'assess: refund falls back to peak/off-peak estimate by tap-in time');
}
{
  const j = mkJourney({ tapInTime: '23:50', tapOutTime: '00:30' });
  const a = assessJourney({ journey: j, timing: TUBE_TIMING, lookup: ledger([]) });
  ok(a.actualMinutes === 40, 'assess: journey past midnight → 40 actual minutes');
}

// --- resolver -----------------------------------------------------------------
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(path.join(dir, '../data/stations.json'), 'utf8'));
  const resolve = makeResolver(data.stations);
  ok(normalizeStationName("King's Cross St. Pancras Underground Station") === 'kings cross st pancras',
    'resolve: normalisation strips punctuation and suffixes');
  ok(resolve('Kings Cross [London Underground]')?.id === '940GZZLUKSX', 'resolve: Oyster-style "Kings Cross [London Underground]"');
  ok(resolve('Finchley Road')?.id === '940GZZLUFYR', 'resolve: exact name beats "Finchley Road & Frognal"');
  ok(resolve('Heathrow Terminals 2 & 3')?.name === 'Heathrow Terminals 2 & 3', 'resolve: ampersand names resolve');
  ok(resolve('Bank')?.name === 'Bank', 'resolve: short exact name');
  ok(resolve('Narnia Central') === null, 'resolve: unknown station → null');
}

// --- snapshot lookup (bundled ledger) -------------------------------------------
{
  const snap: LedgerSnapshot = {
    generatedAt: 'x', sinceISO: 'x',
    coverage: [{ from: '2026-07-04T10:00:00Z', to: '2026-07-04T18:00:00Z', polls: 96 }],
    spans: [
      {
        line: 'central', lineName: 'Central', from: '2026-07-04T11:00:00Z', to: '2026-07-04T14:00:00Z',
        severity: 6, description: 'Severe Delays', reason: 'Signal failure',
      },
      {
        line: 'jubilee', lineName: 'Jubilee', from: '2026-07-04T11:00:00Z', to: '2026-07-04T14:00:00Z',
        severity: 9, description: 'Minor Delays', reason: null,
      },
    ],
  };
  const lookup = makeSnapshotLookup(snap);
  const hit = lookup(['central'], '2026-07-04T13:00:00Z', '2026-07-04T13:30:00Z');
  ok(hit.coverage === 96 && hit.statuses.length === 1, 'snapshot: window inside a span → coverage + status');
  ok(hit.statuses[0].ts === '2026-07-04T13:00:00Z', 'snapshot: span start clamped into the window');
  const early = lookup(['central'], '2026-07-04T10:00:00Z', '2026-07-04T11:30:00Z');
  ok(early.statuses[0].ts === '2026-07-04T11:00:00Z', 'snapshot: span starting mid-window keeps its own ts');
  const both = lookup(['central', 'jubilee'], '2026-07-04T12:00:00Z', '2026-07-04T13:00:00Z');
  ok(both.statuses.length === 2 && both.statuses[0].line === 'central', 'snapshot: worst severity sorts first');
  const miss = lookup(['victoria'], '2026-07-04T13:00:00Z', '2026-07-04T13:30:00Z');
  ok(miss.coverage === 96 && miss.statuses.length === 0, 'snapshot: healthy line → coverage, no statuses');
  const gap = lookup(['central'], '2026-07-05T09:00:00Z', '2026-07-05T10:00:00Z');
  ok(gap.coverage === 0 && gap.statuses.length === 0, 'snapshot: window outside coverage → collector gap');
}

// --- claim deadline ---------------------------------------------------------------
{
  const d = claimDeadline('2026-06-10', '2026-06-15');
  ok(d.deadline === '2026-07-08' && d.daysLeft === 23, 'deadline: 28-day window, 23 days left after 5');
  ok(claimDeadline('2026-06-10', '2026-07-08').daysLeft === 0, 'deadline: day 28 is the last day');
  ok(claimDeadline('2026-06-10', '2026-07-09').daysLeft === -1, 'deadline: day 29 is expired');
}

// --- display helpers ---------------------------------------------------------------
ok(formatDay('2026-06-10') === 'Wednesday 10 June 2026', 'format: formatDay');
{
  const g = groupByDay([
    { date: '2026-06-11', id: 1 }, { date: '2026-06-11', id: 2 }, { date: '2026-06-10', id: 3 },
  ]);
  ok(g.length === 2 && g[0].data.length === 2 && g[1].title === 'Wednesday 10 June 2026',
    'format: groupByDay keeps order and splits sections on date change');
}

console.log(`\nAll ${passed} assertions passed.`);
