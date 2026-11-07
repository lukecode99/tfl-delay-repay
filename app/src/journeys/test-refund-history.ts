// Tests for the Delay Repay refund-history parser + matcher (TfL-36).
//   node --experimental-strip-types src/journeys/test-refund-history.ts
import { strict as assert } from 'node:assert';
import {
  parseRefundHistory, parseRefundDate, classifyStatus, htmlToLines,
  matchRefundApplicationsToJourneys, isReceivedStatus,
  type RefundApplication,
} from './refund-history.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

const NOW = '2026-11-07';

// A page shaped like Luke's screen: one month group, three submitted entries,
// each followed by the "notified separately" notice line.
const PAGE = `
<html><body>
  <h1>Refund history</h1>
  <p>VISA ending 5006</p>
  <section>
    <h2>October</h2>
    <div class="item">
      <span class="date">Wed 28 Oct</span>
      <span class="route">White City to Northolt</span>
      <p>Service delay refund application submitted</p>
      <p>You will be notified of the outcome separately via email</p>
    </div>
    <div class="item">
      <span class="date">Thu 22 Oct</span>
      <span class="route">South Ruislip to White City</span>
      <p>Service delay refund application submitted</p>
      <p>You will be notified of the outcome separately via email</p>
    </div>
    <div class="item">
      <span class="date">Wed 21 Oct</span>
      <span class="route">Great Portland Street to Eastcote</span>
      <p>Service delay refund application submitted</p>
      <p>You will be notified of the outcome separately via email</p>
    </div>
  </section>
</body></html>`;

test('parses every entry on the page with date + route + status', () => {
  const apps = parseRefundHistory(PAGE, NOW, 'card1');
  assert.equal(apps.length, 3);
  assert.deepEqual(apps.map(a => a.date), ['2026-10-28', '2026-10-22', '2026-10-21']);
  assert.deepEqual(apps[2], {
    date: '2026-10-21',
    origin: 'Great Portland Street',
    destination: 'Eastcote',
    status: 'submitted',
    rawStatus: 'Service delay refund application submitted',
    card: 'card1',
  });
  assert.ok(apps.every(a => a.status === 'submitted'));
});

test('the "notified separately via email" notice never becomes an entry', () => {
  const apps = parseRefundHistory(PAGE, NOW, 'card1');
  assert.ok(apps.every(a => !/notified|email/i.test(a.origin + a.destination)));
});

test('year is inferred: a month after today belongs to last year', () => {
  // nowISO Nov 2026 → a December entry is Dec 2025.
  assert.equal(parseRefundDate('Mon 15 Dec', NOW), '2025-12-15');
  assert.equal(parseRefundDate('Wed 21 Oct', NOW), '2026-10-21');
  assert.equal(parseRefundDate('21 October', NOW), '2026-10-21');
  assert.equal(parseRefundDate('21 Oct 2024', NOW), '2024-10-21'); // explicit year wins
  assert.equal(parseRefundDate('2026-10-21', NOW), '2026-10-21'); // ISO passthrough
  assert.equal(parseRefundDate('no date here', NOW), null);
});

test('status classification covers submitted/approved/paid/rejected', () => {
  assert.equal(classifyStatus('Service delay refund application submitted'), 'submitted');
  assert.equal(classifyStatus('Your refund has been approved'), 'approved');
  assert.equal(classifyStatus('£5.30 has been refunded to your card'), 'paid');
  assert.equal(classifyStatus('Refund application rejected'), 'rejected');
  assert.equal(classifyStatus('We were unable to approve your refund'), 'rejected');
  assert.equal(classifyStatus('something unrelated'), 'unknown');
});

test('htmlToLines strips tags and decodes entities', () => {
  const lines = htmlToLines('<div>Great&nbsp;Portland Street to Eastcote</div><p>submitted &amp; done</p>');
  assert.deepEqual(lines, ['Great Portland Street to Eastcote', 'submitted & done']);
});

test('empty / junk HTML yields no entries, never throws', () => {
  assert.deepEqual(parseRefundHistory('', NOW), []);
  assert.deepEqual(parseRefundHistory('<html><body>No refunds yet</body></html>', NOW), []);
});

test('duplicate rows across responsive layouts are deduped', () => {
  const doubled = PAGE + PAGE;
  assert.equal(parseRefundHistory(doubled, NOW, 'card1').length, 3);
});

// --- matcher ---
const APP = (date: string, origin: string, destination: string, status: any = 'submitted', card = 'c1'): RefundApplication =>
  ({ date, origin, destination, status, rawStatus: status, card });
const JNY = (id: number, date: string, origin: string, destination: string | null, card = 'c1') =>
  ({ id, date, origin, destination, card });

test('matches a journey by date + route and returns the status', () => {
  const apps = [APP('2026-10-21', 'Great Portland Street', 'Eastcote', 'submitted')];
  const journeys = [JNY(7, '2026-10-21', 'Great Portland Street', 'Eastcote')];
  const m = matchRefundApplicationsToJourneys(apps, journeys);
  assert.equal(m.get(7), 'submitted');
});

test('route match is case/punctuation insensitive', () => {
  const apps = [APP('2026-10-21', 'great portland st.', 'EASTCOTE')];
  const journeys = [JNY(7, '2026-10-21', 'Great Portland St', 'Eastcote')];
  assert.equal(matchRefundApplicationsToJourneys(apps, journeys).get(7), 'submitted');
});

test('±1 day timezone slack still matches', () => {
  const apps = [APP('2026-10-21', 'A', 'B')];
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-22', 'A', 'B')]).get(1), 'submitted');
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-23', 'A', 'B')]).size, 0);
});

test('a journey missing its destination (incomplete) never matches', () => {
  const apps = [APP('2026-10-21', 'A', 'B')];
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-21', 'A', null)]).size, 0);
});

test('ambiguous (two identical journeys) tags NONE', () => {
  const apps = [APP('2026-10-21', 'A', 'B')];
  const journeys = [JNY(1, '2026-10-21', 'A', 'B'), JNY(2, '2026-10-21', 'A', 'B')];
  assert.equal(matchRefundApplicationsToJourneys(apps, journeys).size, 0);
});

test('different card excludes; unknown on either side does not', () => {
  const apps = [APP('2026-10-21', 'A', 'B', 'submitted', 'cardA')];
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-21', 'A', 'B', 'cardB')]).size, 0);
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-21', 'A', 'B', 'unknown')]).get(1), 'submitted');
});

test('conflicting statuses keep the strongest (paid over submitted)', () => {
  const apps = [APP('2026-10-21', 'A', 'B', 'submitted'), APP('2026-10-21', 'A', 'B', 'paid')];
  assert.equal(matchRefundApplicationsToJourneys(apps, [JNY(1, '2026-10-21', 'A', 'B')]).get(1), 'paid');
});

test('isReceivedStatus: submitted/approved/paid yes, rejected/unknown no', () => {
  assert.ok(isReceivedStatus('submitted') && isReceivedStatus('approved') && isReceivedStatus('paid'));
  assert.ok(!isReceivedStatus('rejected') && !isReceivedStatus('unknown'));
});

test('end-to-end: parse the page, match Luke\'s three journeys', () => {
  const apps = parseRefundHistory(PAGE, NOW, 'c1');
  const journeys = [
    JNY(1, '2026-10-28', 'White City', 'Northolt'),
    JNY(2, '2026-10-22', 'South Ruislip', 'White City'),
    JNY(3, '2026-10-21', 'Great Portland Street', 'Eastcote'),
    JNY(4, '2026-10-20', 'Baker Street', 'Bond Street'), // no refund
  ];
  const m = matchRefundApplicationsToJourneys(apps, journeys);
  assert.deepEqual([...m.keys()].sort(), [1, 2, 3]);
  assert.ok([...m.values()].every(s => s === 'submitted'));
});

console.log(`\n${n} refund-history tests passed`);
