// Tests for refund→journey matching (Received filter, 4-Nov).
//   node --experimental-strip-types src/journeys/test-refund-match.ts
import { strict as assert } from 'node:assert';
import { matchRefundsToJourneys } from './refund-match.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

const J = (id: number, date: string, charge: number | null, card = 'c1') => ({ id, date, charge, card });

test('unique full-fare match within window tags the journey', () => {
  const journeys = [J(1, '2026-10-01', 3.40)];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'c1' }];
  assert.deepEqual([...matchRefundsToJourneys(refunds, journeys)], [1]);
});

test('half-fare refund (15–29 min delay) corroborates', () => {
  const journeys = [J(1, '2026-10-01', 3.40)];
  const refunds = [{ date: '2026-10-03', amount: 1.70, card: 'c1' }];
  assert.deepEqual([...matchRefundsToJourneys(refunds, journeys)], [1]);
});

test('amount off by more than 50p does not match', () => {
  const journeys = [J(1, '2026-10-01', 3.40)];
  const refunds = [{ date: '2026-10-03', amount: 5.00, card: 'c1' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('refund before the journey never matches', () => {
  const journeys = [J(1, '2026-10-10', 3.40)];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'c1' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('outside the 21-day window does not match', () => {
  const journeys = [J(1, '2026-10-01', 3.40)];
  const refunds = [{ date: '2026-10-25', amount: 3.40, card: 'c1' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('ambiguous (two same-fare journeys in window) tags NONE', () => {
  const journeys = [J(1, '2026-10-01', 3.40), J(2, '2026-10-02', 3.40)];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'c1' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('different card excludes the journey', () => {
  const journeys = [J(1, '2026-10-01', 3.40, 'cardA')];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'cardB' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('unknown card on either side does not exclude', () => {
  const journeys = [J(1, '2026-10-01', 3.40, 'unknown')];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'cardB' }];
  assert.deepEqual([...matchRefundsToJourneys(refunds, journeys)], [1]);
});

test('journey with no charge cannot be corroborated', () => {
  const journeys = [J(1, '2026-10-01', null)];
  const refunds = [{ date: '2026-10-05', amount: 3.40, card: 'c1' }];
  assert.equal(matchRefundsToJourneys(refunds, journeys).size, 0);
});

test('two distinct refunds each tag their own unique journey', () => {
  const journeys = [J(1, '2026-10-01', 3.40), J(2, '2026-10-02', 2.80)];
  const refunds = [
    { date: '2026-10-05', amount: 3.40, card: 'c1' },
    { date: '2026-10-06', amount: 2.80, card: 'c1' },
  ];
  assert.deepEqual([...matchRefundsToJourneys(refunds, journeys)].sort(), [1, 2]);
});

test('empty inputs are safe', () => {
  assert.equal(matchRefundsToJourneys([], [J(1, '2026-10-01', 3.40)]).size, 0);
  assert.equal(matchRefundsToJourneys([{ date: '2026-10-05', amount: 3.40 }], []).size, 0);
});

console.log(`\n${n} refund-match tests passed`);
