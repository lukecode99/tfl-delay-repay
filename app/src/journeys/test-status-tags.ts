// Tests for the multi-status tag model (home v1.2).
//   node --experimental-strip-types src/journeys/test-status-tags.ts
import { strict as assert } from 'node:assert';
import { matchesFilter, statusTags } from './status-tags.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

test('eligible only', () => {
  const t = statusTags({ eligible: true, claimStatus: null, daysLeft: 5 });
  assert.deepEqual([...t].sort(), ['eligible']);
});

test('statuses coexist: eligible + claimed + rejected', () => {
  const t = statusTags({ eligible: true, claimStatus: 'rejected', daysLeft: -40 });
  assert.deepEqual([...t].sort(), ['claimed', 'eligible', 'rejected']);
});

test('awaiting = open claim, still tagged claimed', () => {
  const t = statusTags({ eligible: true, claimStatus: 'claimed', daysLeft: 2 });
  assert.deepEqual([...t].sort(), ['awaiting', 'claimed', 'eligible']);
});

test('received = paid claim', () => {
  const t = statusTags({ eligible: true, claimStatus: 'paid', daysLeft: -3 });
  assert.deepEqual([...t].sort(), ['claimed', 'eligible', 'received']);
});

test('missed = eligible, unclaimed, window closed', () => {
  const t = statusTags({ eligible: true, claimStatus: null, daysLeft: -1 });
  assert.deepEqual([...t].sort(), ['eligible', 'missed']);
});

test('not missed while window open (daysLeft 0 = last day today)', () => {
  const t = statusTags({ eligible: true, claimStatus: null, daysLeft: 0 });
  assert.equal(t.has('missed'), false);
});

test('claiming clears missed even after window closes', () => {
  const t = statusTags({ eligible: true, claimStatus: 'claimed', daysLeft: -10 });
  assert.equal(t.has('missed'), false);
});

test('ineligible journeys never tag missed', () => {
  const t = statusTags({ eligible: false, claimStatus: null, daysLeft: -10 });
  assert.equal(t.size, 0);
});

test('overcharged tags overcharged AND eligible (even pending-auto)', () => {
  const t = statusTags({ eligible: false, overcharged: true, claimStatus: null, daysLeft: 20 });
  assert.deepEqual([...t].sort(), ['eligible', 'overcharged']);
});

test('overcharged alone never tags missed — missed is delay-claims only', () => {
  const t = statusTags({ eligible: false, overcharged: true, claimStatus: null, daysLeft: -10 });
  assert.deepEqual([...t].sort(), ['eligible', 'overcharged']);
});

test('overcharged omitted behaves as before', () => {
  const t = statusTags({ eligible: true, claimStatus: null, daysLeft: 5 });
  assert.deepEqual([...t].sort(), ['eligible']);
});

// TfL-35: 60-day auto-reject (derived, non-destructive).
test('claimed < 60 days stays awaiting', () => {
  const t = statusTags({ eligible: true, claimStatus: 'claimed', claimedAt: '2026-09-01T10:00:00.000Z', today: '2026-10-15', daysLeft: -5 });
  assert.deepEqual([...t].sort(), ['awaiting', 'claimed', 'eligible']);
});

test('claimed >= 60 days ages out to rejected, drops awaiting', () => {
  const t = statusTags({ eligible: true, claimStatus: 'claimed', claimedAt: '2026-08-01T10:00:00.000Z', today: '2026-10-15', daysLeft: -40 });
  assert.deepEqual([...t].sort(), ['claimed', 'eligible', 'rejected']);
  assert.equal(t.has('awaiting'), false);
});

test('60 days exactly ages out (boundary)', () => {
  const t = statusTags({ eligible: false, claimStatus: 'claimed', claimedAt: '2026-08-15', today: '2026-10-14', daysLeft: -1 });
  assert.equal(t.has('rejected'), true);
  assert.equal(t.has('awaiting'), false);
});

test('a paid claim is never aged out, even past 60 days', () => {
  const t = statusTags({ eligible: true, claimStatus: 'paid', claimedAt: '2026-01-01T10:00:00.000Z', today: '2026-10-15', daysLeft: -200 });
  assert.deepEqual([...t].sort(), ['claimed', 'eligible', 'received']);
  assert.equal(t.has('rejected'), false);
});

test('without today, old claim still shows awaiting (back-compat)', () => {
  const t = statusTags({ eligible: true, claimStatus: 'claimed', claimedAt: '2026-01-01T10:00:00.000Z', daysLeft: -200 });
  assert.deepEqual([...t].sort(), ['awaiting', 'claimed', 'eligible']);
});

test('matchesFilter: all matches everything, tags match membership', () => {
  const t = statusTags({ eligible: true, claimStatus: 'rejected', daysLeft: -40 });
  assert.equal(matchesFilter(t, 'all'), true);
  assert.equal(matchesFilter(t, 'rejected'), true);
  assert.equal(matchesFilter(t, 'eligible'), true);
  assert.equal(matchesFilter(t, 'missed'), false);
  assert.equal(matchesFilter(new Set(), 'all'), true);
});

console.log(`${n} tests passed`);
