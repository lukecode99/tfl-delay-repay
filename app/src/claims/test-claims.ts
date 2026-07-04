// Claim prefill tests — run with:
//   node --experimental-strip-types src/claims/test-claims.ts
import assert from 'node:assert/strict';
import { buildFillScript, buildPrefill, CLAIM_START_URL, ukDate } from './prefill.ts';
import { planReminders, REMINDER_OFFSETS } from './reminders.ts';
import { claimTotals } from './stats.ts';
import type { ParsedJourney } from '../journeys/parse';
import type { Assessment } from '../eligibility/engine';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const journey: ParsedJourney = {
  card: 'test', date: '2026-06-10', tapInTime: '08:00', tapOutTime: '08:55',
  origin: 'Finchley Road', destination: 'Bank', charge: 3.1, incomplete: false,
  rawAction: 'Finchley Road to Bank',
};
const assessment = {
  status: 'eligible', reasonCode: 'ok', overageMinutes: 31, refundValue: 3.1, plausibleLines: ['jubilee'],
} as Assessment;

ok(ukDate('2026-06-10') === '10/06/2026', 'prefill: ISO date → UK date');

{
  const f = buildPrefill(journey, assessment);
  const byKey = Object.fromEntries(f.map(x => [x.key, x.value]));
  ok(byKey.date === '10/06/2026', 'prefill: date field in UK format');
  ok(byKey.timeIn === '08:00' && byKey.timeOut === '08:55', 'prefill: touch in/out times');
  ok(byKey.origin === 'Finchley Road' && byKey.destination === 'Bank', 'prefill: stations');
  ok(byKey.delay === '31', 'prefill: delay minutes from assessment overage');
  ok(f.every(x => x.keywords.length > 0 && x.label), 'prefill: every field has keywords and a chip label');
}
{
  const f = buildPrefill({ ...journey, destination: null, tapOutTime: null, incomplete: true }, undefined);
  const keys = f.map(x => x.key);
  ok(!keys.includes('destination') && !keys.includes('timeOut') && !keys.includes('delay'),
    'prefill: incomplete journey drops empty fields and delay without assessment');
  ok(keys.includes('date') && keys.includes('origin'), 'prefill: date and origin always present');
}
{
  const script = buildFillScript(buildPrefill(journey, assessment));
  ok(script.includes('Finchley Road') && script.includes('10/06/2026'), 'script: embeds field values');
  // Parses as valid JS (references document/window but new Function only parses).
  new Function(script);
  ok(true, 'script: syntactically valid JavaScript');
  ok(script.includes('postMessage'), 'script: reports fill result back to the app');
  ok(script.trimEnd().endsWith('true;'), 'script: ends with true for injectJavaScript');
}
{
  const evil = buildFillScript(buildPrefill({ ...journey, origin: 'X"; alert(1); //' }, undefined));
  new Function(evil);
  ok(true, 'script: values are JSON-escaped — hostile station names stay data');
}
ok(CLAIM_START_URL.startsWith('https://tfl.gov.uk/'), 'claim flow starts on tfl.gov.uk');

// --- TfL-7: reminder planning ---
// Journey 2026-06-10 → 28-day deadline 2026-07-08 (caller computes this via claimDeadline).
const rj = (over: object) => ({
  journeyId: 1, date: '2026-06-10', origin: 'Finchley Road', destination: 'Bank',
  eligible: true, claimed: false, refundValue: 3.1, deadline: '2026-07-08', daysLeft: 23, ...over,
});
{
  // Reminders 2026-07-03 (T−5) and 2026-07-07 (T−1).
  const plan = planReminders([rj({})], '2026-06-15');
  ok(plan.length === 2 && plan[0].fireDate === '2026-07-03' && plan[1].fireDate === '2026-07-07',
    'reminders: T−5 and T−1 before the 28-day deadline');
  ok(plan[0].id === 'claim-1-t5' && plan[1].id === 'claim-1-t1', 'reminders: stable per-journey identifiers');
  ok(plan[1].body.includes('Finchley Road → Bank') && plan[1].body.includes('1 day left')
    && plan[1].body.includes('£3.10'), 'reminders: body names the route, days left and value');
}
{
  const plan = planReminders([rj({})], '2026-07-05'); // T−5 date already past
  ok(plan.length === 1 && plan[0].fireDate === '2026-07-07', 'reminders: past fire dates dropped');
  ok(planReminders([rj({})], '2026-07-07').length === 1, 'reminders: same-day fire date kept');
}
ok(planReminders([rj({ claimed: true }), rj({ eligible: false }), rj({ daysLeft: -3, deadline: '2026-01-29' })], '2026-06-15').length === 0,
  'reminders: claimed, ineligible and expired journeys get none');
ok(REMINDER_OFFSETS.join(',') === '5,1', 'reminders: offsets per card are T−5 and T−1');

// --- TfL-7: lifetime totals ---
{
  const t = claimTotals([
    { status: 'claimed', expectedValue: 3.1, paidAmount: null },
    { status: 'paid', expectedValue: 2.9, paidAmount: 2.9 },
    { status: 'paid', expectedValue: 5.0, paidAmount: null }, // paid, amount not recorded
    { status: 'rejected', expectedValue: 4.0, paidAmount: null },
  ]);
  ok(t.claimedCount === 4 && Math.abs(t.claimedValue - 15.0) < 1e-9, 'totals: claimed £ sums expected values');
  ok(t.paidCount === 2 && Math.abs(t.paidValue - 7.9) < 1e-9, 'totals: received £ uses paid amount, falls back to expected');
  ok(t.rejectedCount === 1 && t.openCount === 1, 'totals: rejected and awaiting counts');
}
ok(claimTotals([]).claimedCount === 0 && claimTotals([]).paidValue === 0, 'totals: empty ledger is all zeros');

console.log(`\nAll ${passed} assertions passed.`);
