// node --experimental-strip-types src/journeys/test-home-stats.ts
import { attentionList } from './home-stats.ts';
import type { StoredJourney } from './db.ts';
import type { Assessment } from '../eligibility/engine.ts';
import type { ClaimRecord } from '../claims/db.ts';
import type { OverchargeCandidate } from './incomplete-fare.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

// --- Minimal stubs ---

function journey(id: number, date: string): StoredJourney {
  return { id, date, origin: 'A', destination: 'B', charge: null, tapInTime: null, tapOutTime: null, incomplete: false, card: null } as StoredJourney;
}

function assessments(pairs: [number, 'eligible' | 'not-eligible'][]) {
  return new Map(pairs.map(([id, status]) => [id, { status } as Assessment]));
}

function overcharges(pairs: [number, 'claimable' | 'pending-auto' | 'expired'][]) {
  return new Map(pairs.map(([id, claimStatus]) => [id, { claimStatus, estimatedRefund: 1 } as unknown as OverchargeCandidate]));
}

function claims(pairs: [number, 'claimed' | 'paid' | 'rejected'][]) {
  return new Map(pairs.map(([id, status]) => [id, { journeyId: id, status } as ClaimRecord]));
}

// Today is well inside the 28-day claim window for this test date.
const TODAY = '2026-07-29';
const RECENT = '2026-07-20'; // 9 days ago — within window
const OLD = '2026-06-01';   // 58 days ago — past window

// --- 1. Delay-repay eligible, unclaimed, within window → appears ---
{
  const js = [journey(1, RECENT)];
  const result = attentionList(js, assessments([[1, 'eligible']]), overcharges([]), claims([]), TODAY);
  assert(result.length === 1 && result[0].id === 1, 'delay-repay eligible unclaimed within window → in list');
}

// --- 2. Delay-repay eligible, claimed → NOT in list ---
{
  const js = [journey(2, RECENT)];
  const result = attentionList(js, assessments([[2, 'eligible']]), overcharges([]), claims([[2, 'claimed']]), TODAY);
  assert(result.length === 0, 'delay-repay eligible but claimed → not in list');
}

// --- 3. THE BUG: overcharge-only journey (not delay-repay eligible), unclaimed, claimable → appears ---
{
  const js = [journey(3, RECENT)];
  const result = attentionList(
    js,
    assessments([[3, 'not-eligible']]), // delay-repay NOT eligible
    overcharges([[3, 'claimable']]),     // but has active overcharge
    claims([]),
    TODAY,
  );
  assert(result.length === 1 && result[0].id === 3, 'overcharge-only unclaimed claimable → in list (bug fix)');
}

// --- 4. Overcharge-only, but overcharge is expired → NOT in list ---
{
  const js = [journey(4, RECENT)];
  const result = attentionList(
    js,
    assessments([[4, 'not-eligible']]),
    overcharges([[4, 'expired']]),
    claims([]),
    TODAY,
  );
  assert(result.length === 0, 'overcharge expired → not in list');
}

// --- 5. Overcharge-only, claimed → NOT in list ---
{
  const js = [journey(5, RECENT)];
  const result = attentionList(
    js,
    assessments([[5, 'not-eligible']]),
    overcharges([[5, 'claimable']]),
    claims([[5, 'claimed']]),
    TODAY,
  );
  assert(result.length === 0, 'overcharge claimed → not in list');
}

// --- 6. Delay-repay eligible, past window (missed) → NOT in list ---
{
  const js = [journey(6, OLD)];
  const result = attentionList(js, assessments([[6, 'eligible']]), overcharges([]), claims([]), TODAY);
  assert(result.length === 0, 'eligible but past claim window → not in list');
}

// --- 7. Not eligible, no overcharge → NOT in list ---
{
  const js = [journey(7, RECENT)];
  const result = attentionList(js, assessments([[7, 'not-eligible']]), overcharges([]), claims([]), TODAY);
  assert(result.length === 0, 'not eligible, no overcharge → not in list');
}

// --- 8. pending-auto overcharge counts as claimable (recoverable money) → appears ---
{
  const js = [journey(8, RECENT)];
  const result = attentionList(
    js,
    assessments([[8, 'not-eligible']]),
    overcharges([[8, 'pending-auto']]),
    claims([]),
    TODAY,
  );
  assert(result.length === 1, 'pending-auto overcharge → in list (still recoverable)');
}

// --- 9. Both delay-repay eligible AND overcharged, unclaimed → appears once ---
{
  const js = [journey(9, RECENT)];
  const result = attentionList(
    js,
    assessments([[9, 'eligible']]),
    overcharges([[9, 'claimable']]),
    claims([]),
    TODAY,
  );
  assert(result.length === 1, 'eligible + overcharged → appears once, not twice');
}

// --- 10. Mixed list: only actionable journeys returned ---
{
  const js = [
    journey(10, RECENT), // delay-repay eligible unclaimed
    journey(11, RECENT), // overcharge-only unclaimed
    journey(12, RECENT), // claimed
    journey(13, OLD),    // missed
    journey(14, RECENT), // not eligible, no overcharge
  ];
  const result = attentionList(
    js,
    assessments([[10, 'eligible'], [11, 'not-eligible'], [12, 'eligible'], [13, 'eligible'], [14, 'not-eligible']]),
    overcharges([[11, 'claimable']]),
    claims([[12, 'claimed']]),
    TODAY,
  );
  assert(result.length === 2, 'mixed list: only journeys 10 and 11 appear');
  assert(result.some(j => j.id === 10), 'journey 10 (delay-repay) in result');
  assert(result.some(j => j.id === 11), 'journey 11 (overcharge) in result');
}

console.log(`home-stats: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
