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

// VERBATIM markup captured from Luke's live account (refund-raw audit,
// 24-Nov-2026, build 97) — tile structure, attribute order and text exactly as
// TfL serves it, extended to three entries. THE canonical fixture: if this
// test breaks, TfL changed the page.
const REAL_PAGE = `
<html><body>
<h2 id="selectedcard-name">ending in 5006</h2>
<div class="statements-list">
  <button id="journey-date-heading-0" tabindex="0" class="list-group-item collapsed journey-date-heading" data-toggle="collapse" data-target="#journey-0" aria-expanded="false" aria-controls="journey-0" data-pageobject="journey-date-heading">
    <span class="pull-right font-plus" aria-hidden="true"></span> October
  </button>
  <div class="list-group collapse" id="journey-0" aria-labelledby="journey-date-heading-0">
    <div class="list-group-item journey-tile">
      <div class="row" data-pageobject="statement-paymentrow">
        <div class="col-xs-12">
          <h3 data-pageobject="refund-travelday">Wednesday 28th October 2026</h3>
          <p>
            <span class="journey-to-from" data-pageobject="refund-journey-to-from">
              <span data-pageobject="journey-from">White City</span>
              <span>to</span>
              <span data-pageobject="journey-to">Northolt</span>
            </span>
          </p>
          <h4 class="refund-status" data-pageobject="refund-status">Service delay refund application submitted</h4>
          <p data-pageobject="refund-message">You will be notified of the outcome separately via email.</p>
        </div>
      </div>
    </div>
    <div class="list-group-item journey-tile">
      <div class="row" data-pageobject="statement-paymentrow">
        <div class="col-xs-12">
          <h3 data-pageobject="refund-travelday">Thursday 22nd October 2026</h3>
          <p>
            <span class="journey-to-from" data-pageobject="refund-journey-to-from">
              <span data-pageobject="journey-from">South Ruislip</span>
              <span>to</span>
              <span data-pageobject="journey-to">White City</span>
            </span>
          </p>
          <h4 class="refund-status" data-pageobject="refund-status">Service delay refund application submitted</h4>
          <p data-pageobject="refund-message">You will be notified of the outcome separately via email.</p>
        </div>
      </div>
    </div>
    <div class="list-group-item journey-tile">
      <div class="row" data-pageobject="statement-paymentrow">
        <div class="col-xs-12">
          <h3 data-pageobject="refund-travelday">Wednesday 21st October 2026</h3>
          <p>
            <span class="journey-to-from" data-pageobject="refund-journey-to-from">
              <span data-pageobject="journey-from">Great Portland Street</span>
              <span>to</span>
              <span data-pageobject="journey-to">Eastcote</span>
            </span>
          </p>
          <h4 class="refund-status" data-pageobject="refund-status">Service delay refund application submitted</h4>
          <p data-pageobject="refund-message">You will be notified of the outcome separately via email.</p>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

test('REAL captured markup: parses all three applications (TfL-37)', () => {
  const apps = parseRefundHistory(REAL_PAGE, NOW, '2f6956f8');
  assert.equal(apps.length, 3);
  assert.deepEqual(apps[0], {
    date: '2026-10-28',
    origin: 'White City',
    destination: 'Northolt',
    status: 'submitted',
    rawStatus: 'Service delay refund application submitted',
    card: '2f6956f8',
  });
  assert.deepEqual(apps.map(a => a.date), ['2026-10-28', '2026-10-22', '2026-10-21']);
  assert.deepEqual(apps.map(a => `${a.origin}>${a.destination}`),
    ['White City>Northolt', 'South Ruislip>White City', 'Great Portland Street>Eastcote']);
});

test('REAL markup: a tile with an unrecognised status still stores rawStatus', () => {
  const page = REAL_PAGE.replace('Service delay refund application submitted',
    'Some future wording TfL has not shown us yet');
  const apps = parseRefundHistory(page, NOW, 'c1');
  assert.equal(apps.length, 3);
  assert.equal(apps[0].status, 'unknown');
  assert.equal(apps[0].rawStatus, 'Some future wording TfL has not shown us yet');
});

test('REAL markup: a tile missing its route is skipped, others survive', () => {
  const page = REAL_PAGE.replace('<span data-pageobject="journey-from">White City</span>', '');
  const apps = parseRefundHistory(page, NOW, 'c1');
  assert.equal(apps.length, 2);
  assert.ok(apps.every(a => a.origin !== 'White City' || a.destination !== 'Northolt'));
});

test('REAL markup: full-weekday ordinal dates parse (parseRefundDate)', () => {
  assert.equal(parseRefundDate('Wednesday 28th October 2026', NOW), '2026-10-28');
  assert.equal(parseRefundDate('Thursday 22nd October 2026', NOW), '2026-10-22');
  assert.equal(parseRefundDate('Monday 1st December 2025', NOW), '2025-12-01');
  assert.equal(parseRefundDate('Saturday 3rd January 2026', NOW), '2026-01-03');
});

test('REAL markup end-to-end: applications match Luke\'s journeys by date + route', () => {
  const apps = parseRefundHistory(REAL_PAGE, NOW, 'unknown');
  const journeys = [
    { id: 1, date: '2026-10-28', origin: 'White City', destination: 'Northolt', card: '2f6956f8' },
    { id: 2, date: '2026-10-22', origin: 'South Ruislip', destination: 'White City', card: '2f6956f8' },
    { id: 3, date: '2026-10-21', origin: 'Great Portland Street', destination: 'Eastcote', card: '2f6956f8' },
    { id: 4, date: '2026-10-20', origin: 'Baker Street', destination: 'Bond Street', card: '2f6956f8' },
  ];
  const m = matchRefundApplicationsToJourneys(apps, journeys);
  assert.deepEqual([...m.keys()].sort(), [1, 2, 3]);
  assert.ok([...m.values()].every(s => s === 'submitted'));
});

test('empty-history page ("processed no refund applications") parses to zero', () => {
  const page = '<html><body><h2 id="selectedcard-name">ending in 1234</h2>'
    + '<p>We have processed no refund applications in the last 12 weeks.</p></body></html>';
  assert.deepEqual(parseRefundHistory(page, NOW, 'c9'), []);
});

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
