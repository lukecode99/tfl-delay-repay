// Claim prefill tests — run with:
//   node --experimental-strip-types src/claims/test-claims.ts
import assert from 'node:assert/strict';
import { buildFillScript, buildPrefill, CLAIM_START_URL, lineLabel, ukDate } from './prefill.ts';
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
ok(lineLabel('piccadilly') === 'Piccadilly' && lineLabel('hammersmith-city') === 'Hammersmith & City'
  && lineLabel('elizabeth') === 'Elizabeth line', 'prefill: line ids → TfL display names');

{
  const f = buildPrefill(journey, assessment);
  const byKey = Object.fromEntries(f.map(x => [x.key, x.value]));
  ok(byKey.date === '10/06/2026', 'prefill: date field in UK format');
  ok(byKey.timeIn === '08:00' && byKey.timeOut === '08:55', 'prefill: touch in/out times');
  ok(byKey.origin === 'Finchley Road' && byKey.destination === 'Bank', 'prefill: stations');
  ok(byKey.delay === '31', 'prefill: delay minutes from assessment overage');
  ok(byKey.line === 'Jubilee', 'prefill: line from assessment plausible lines');
  ok(byKey.card === 'test', 'prefill: card identifier included');
  ok(f.findIndex(x => x.key === 'line') < f.findIndex(x => x.key === 'delay'),
    'prefill: line field ordered before delay (claims the "delayed line" dropdown first)');
  ok(f.every(x => x.keywords.length > 0 && x.label), 'prefill: every field has keywords and a chip label');
}
{
  const f = buildPrefill({ ...journey, destination: null, tapOutTime: null, incomplete: true }, undefined);
  const keys = f.map(x => x.key);
  ok(!keys.includes('destination') && !keys.includes('timeOut') && !keys.includes('delay') && !keys.includes('line'),
    'prefill: incomplete journey drops empty fields; no line/delay without assessment');
  ok(keys.includes('date') && keys.includes('origin'), 'prefill: date and origin always present');
}
{
  const f = buildPrefill({ ...journey, origin: 'Kings Cross [London Underground]', card: 'unknown' },
    { ...assessment, disruption: { line: 'piccadilly', description: 'Severe Delays', reason: null, ts: '' } } as Assessment);
  const byKey = Object.fromEntries(f.map(x => [x.key, x.value]));
  ok(byKey.origin === 'Kings Cross', 'prefill: bracketed CSV suffix stripped from station names');
  ok(byKey.line === 'Piccadilly', 'prefill: corroborated disruption line wins over plausible lines');
  ok(!('card' in byKey), 'prefill: unknown card identifier omitted');
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

// --- TfL-9: the built script run against a stub DOM of the claim form ---
// The contactless site can't be fetched from CI (auth + WAF), so the fixture
// mirrors its known shapes: jQuery-era selects (some hidden behind
// select2/chosen-style widgets), minute-range delay options, hour/minute and
// day/month/year part-selects, radio card pickers.

interface Opt { value: string; textContent: string; selected?: boolean }
class El {
  tagName: string; type = ''; id = ''; name = ''; placeholder = '';
  value = ''; checked = false; selectedIndex = -1;
  options?: Opt[];
  hidden = false;
  wrapLabel: { textContent: string } | null = null;
  aria: string | null = null;
  events: string[] = [];
  jq: string[] = [];
  constructor(tag: string, props: object = {}) {
    this.tagName = tag.toUpperCase();
    Object.assign(this, props);
  }
  getAttribute(n: string) { return n === 'aria-label' ? this.aria : null; }
  getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 200, height: 24 }; }
  dispatchEvent(ev: { type: string }) { this.events.push(ev.type); return true; }
  closest(sel: string) { return sel === 'label' ? this.wrapLabel : null; }
}
class Doc {
  els: El[]; labels: Record<string, string>;
  constructor(els: El[], labels: Record<string, string> = {}) { this.els = els; this.labels = labels; }
  querySelectorAll(sel: string) { return sel.includes('input') ? this.els : []; }
  querySelector(sel: string) {
    const m = /^label\[for="(.+)"\]$/.exec(sel);
    return m && this.labels[m[1]] ? { textContent: this.labels[m[1]] } : null;
  }
}
function runScript(script: string, doc: Doc, withJQuery = false) {
  const messages: any[] = [];
  const win: any = {
    Event: class { type: string; bubbles: boolean; constructor(type: string, o?: { bubbles?: boolean }) { this.type = type; this.bubbles = !!o?.bubbles; } },
    ReactNativeWebView: { postMessage: (s: string) => messages.push(JSON.parse(s)) },
  };
  if (withJQuery) {
    win.jQuery = (el: El) => {
      const api = { trigger(n: string) { el.jq.push(n); return api; } };
      return api;
    };
  }
  new Function('document', 'window', script)(doc, win);
  return messages[messages.length - 1];
}
const opts = (...texts: string[]): Opt[] => texts.map((t, i) => ({ value: String(i), textContent: t }));
const range = (a: number, b: number, pad = 2): Opt[] => {
  const out: Opt[] = [];
  for (let n = a; n <= b; n++) out.push({ value: String(n), textContent: String(n).padStart(pad, '0') });
  return out;
};

{
  // The full form, Acton Town claim shape: Eastcote → Sudbury Town, 46 min over.
  const dateInput = new El('input', { type: 'text', id: 'JourneyDate' });
  const lineSel = new El('select', { id: 'DelayedLine', options: opts('Please select', 'Bakerloo', 'Central', 'Piccadilly', 'Victoria') });
  const originSel = new El('select', { id: 'StartStation', hidden: true, options: opts('Please select', 'Ealing Common', 'Eastcote', 'Sudbury Town') });
  const destSel = new El('select', { id: 'EndStation', options: opts('Please select', 'Ealing Common', 'Eastcote', 'Sudbury Town') });
  const hourIn = new El('select', { id: 'TimeInHour', options: range(0, 23) });
  const minIn = new El('select', { id: 'TimeInMinute', options: range(0, 59) });
  const hourOut = new El('select', { id: 'TimeOutHour', options: range(0, 23) });
  const minOut = new El('select', { id: 'TimeOutMinute', options: range(0, 59) });
  const delaySel = new El('select', {
    id: 'DelayDuration',
    options: [{ value: '', textContent: 'Please select' },
      { value: 'A', textContent: 'Up to 15 minutes' }, { value: 'B', textContent: '15 to 29 minutes' },
      { value: 'C', textContent: '30 to 59 minutes' }, { value: 'D', textContent: 'More than 1 hour' }],
  });
  const cardA = new El('input', { type: 'radio', name: 'PaymentCardId', wrapLabel: { textContent: 'Mastercard ending 4921' } });
  const cardB = new El('input', { type: 'radio', name: 'PaymentCardId', wrapLabel: { textContent: 'Contactless card 168853655' } });
  const doc = new Doc(
    [dateInput, lineSel, originSel, destSel, hourIn, minIn, hourOut, minOut, delaySel, cardA, cardB],
    {
      JourneyDate: 'Date of journey', DelayedLine: 'Which line were you delayed on?',
      StartStation: 'Start station', EndStation: 'End station',
      TimeInHour: 'Touch in time - hour', TimeInMinute: 'Touch in time - minute',
      TimeOutHour: 'Touch out time - hour', TimeOutMinute: 'Touch out time - minute',
      DelayDuration: 'How long was the delay?',
    });
  const actonJourney: ParsedJourney = {
    card: '168853655', date: '2026-07-04', tapInTime: '10:32', tapOutTime: '11:18',
    origin: 'Eastcote', destination: 'Sudbury Town', charge: 2.2, incomplete: false,
    rawAction: 'Eastcote to Sudbury Town',
  };
  const actonAssessment = {
    status: 'eligible', reasonCode: 'ok', overageMinutes: 46, refundValue: 2.2,
    plausibleLines: ['piccadilly'],
    disruption: { line: 'piccadilly', description: 'Severe Delays', reason: 'signal failure', ts: '' },
  } as Assessment;
  const fields = buildPrefill(actonJourney, actonAssessment);
  const msg = runScript(buildFillScript(fields), doc, true);

  ok(msg.type === 'prefill' && !msg.error, 'fill: script runs and reports');
  ok(msg.filled === msg.total && msg.total === fields.length, 'fill: every known field filled on the fixture form');
  ok(dateInput.value === '04/07/2026', 'fill: date lands in the text input');
  ok(lineSel.value === '3' && lineSel.options![3].selected === true, 'fill: line dropdown → Piccadilly by option text');
  ok(originSel.value === '2', 'fill: HIDDEN start-station select still filled (select2/chosen pattern)');
  ok(destSel.value === '3', 'fill: end-station dropdown → Sudbury Town');
  ok(hourIn.value === '10' && minIn.value === '32', 'fill: touch-in HH:MM split across hour/minute selects');
  ok(hourOut.value === '11' && minOut.value === '18', 'fill: touch-out HH:MM split across hour/minute selects');
  ok(delaySel.value === 'C', 'fill: 46 min delay → "30 to 59 minutes" via numeric range match');
  ok(cardB.checked === true && cardA.checked === false, 'fill: card radio picked by matching label');
  ok(lineSel.events.includes('change') && lineSel.events.includes('input'), 'fill: selects get input+change events');
  ok(lineSel.jq.includes('change') && lineSel.jq.includes('chosen:updated'), 'fill: jQuery widget re-render triggers fired');
  const byKey = Object.fromEntries(msg.results.map((r: any) => [r.key, r]));
  ok(byKey.timeIn.via === 'time-parts' && byKey.origin.via === 'select' && byKey.card.via === 'radio',
    'fill: per-field report says how each field was filled');
}
{
  // Date split across day/month/year selects (no text input).
  const day = new El('select', { id: 'DateDay', options: range(1, 31, 1) });
  const month = new El('select', { id: 'DateMonth', options: opts('Please select', 'January', 'February', 'March', 'April', 'May', 'June', 'July') });
  const year = new El('select', { id: 'DateYear', options: [{ value: '2025', textContent: '2025' }, { value: '2026', textContent: '2026' }] });
  const doc = new Doc([day, month, year], {
    DateDay: 'Date of journey - day', DateMonth: 'Date of journey - month', DateYear: 'Date of journey - year',
  });
  const msg = runScript(buildFillScript([{ key: 'date', label: 'Date', value: '04/07/2026', keywords: ['date'] }]), doc);
  ok(msg.filled === 1 && day.value === '4' && month.options![7].textContent === 'July' && month.value === '7' && year.value === '2026',
    'fill: dd/mm/yyyy split across day/month/year selects (month by name)');
}
{
  // Native date input wants ISO, not UK format.
  const dateInput = new El('input', { type: 'date', id: 'JourneyDate' });
  const doc = new Doc([dateInput], { JourneyDate: 'Date of journey' });
  runScript(buildFillScript([{ key: 'date', label: 'Date', value: '04/07/2026', keywords: ['date'] }]), doc);
  ok(dateInput.value === '2026-07-04', 'fill: <input type=date> gets ISO-coerced value');
}
{
  // TfL renames a field → graceful no-op for that field, everything else fills.
  const known = new El('input', { type: 'text', id: 'StartStation' });
  const doc = new Doc([known], { StartStation: 'Start station' });
  const msg = runScript(buildFillScript([
    { key: 'origin', label: 'From', value: 'Eastcote', keywords: ['start station'] },
    { key: 'ghost', label: 'Ghost', value: 'x', keywords: ['zzz-renamed-field'] },
  ]), doc);
  ok(msg.filled === 1 && msg.total === 2 && !msg.error, 'fill: unmatched field is a graceful no-op, not a crash');
  const ghost = msg.results.find((r: any) => r.key === 'ghost');
  ok(ghost && ghost.filled === false, 'fill: report names the field that could not be filled');
  ok(known.value === 'Eastcote', 'fill: other fields still fill around the miss');
}
{
  // Placeholder options are never chosen; a select that can't take the value is skipped.
  const delaySel = new El('select', { id: 'DelayDuration', options: [{ value: '', textContent: 'Please select an option' }] });
  const doc = new Doc([delaySel], { DelayDuration: 'How long was the delay?' });
  const msg = runScript(buildFillScript([{ key: 'delay', label: 'Delay (min)', value: '46', keywords: ['delay'] }]), doc);
  ok(msg.filled === 0 && delaySel.value === '', 'fill: placeholder option never selected');
}
{
  // A hostile page (querySelectorAll throws) still reports instead of crashing.
  const doc = { querySelectorAll() { throw new Error('boom'); }, querySelector() { return null; } } as any;
  const msg = runScript(buildFillScript([{ key: 'date', label: 'Date', value: '04/07/2026', keywords: ['date'] }]), doc);
  ok(msg.type === 'prefill' && msg.filled === 0 && !msg.error, 'fill: DOM failure degrades to zero-filled report');
}

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
