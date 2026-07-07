// DR15 eligibility + HSP helpers — run with:
//   node --experimental-strip-types src/rail/test-rail-eligibility.ts
import assert from 'node:assert/strict';
import {
  assessRailJourney,
  bandFor,
  bandLabel,
  computeDelay,
  estimateRefund,
  hmToMinutes,
} from './eligibility.ts';
import {
  matchService,
  type HspMetricsResult,
} from './hsp.ts';
import {
  inferOperator,
  searchStations,
  stationByCrs,
} from './stations.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}
function eq<T>(a: T, b: T, msg: string) {
  assert.deepStrictEqual(a, b, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- bandFor ---
eq(bandFor(0), 'none', 'bandFor: 0 min → none');
eq(bandFor(14), 'none', 'bandFor: 14 min → none');
eq(bandFor(15), 'quarter', 'bandFor: 15 min → quarter');
eq(bandFor(29), 'quarter', 'bandFor: 29 min → quarter');
eq(bandFor(30), 'half', 'bandFor: 30 min → half');
eq(bandFor(59), 'half', 'bandFor: 59 min → half');
eq(bandFor(60), 'full-single', 'bandFor: 60 min → full-single');
eq(bandFor(119), 'full-single', 'bandFor: 119 min → full-single');
eq(bandFor(120), 'full-return', 'bandFor: 120 min → full-return');
eq(bandFor(240), 'full-return', 'bandFor: 240 min → full-return');

// --- bandLabel ---
ok(bandLabel('none').includes('Not eligible'), 'bandLabel: none mentions not eligible');
ok(bandLabel('quarter').includes('25'), 'bandLabel: quarter mentions 25%');
ok(bandLabel('half').includes('50'), 'bandLabel: half mentions 50%');
ok(bandLabel('full-single').includes('100'), 'bandLabel: full-single mentions 100%');
ok(bandLabel('full-return').includes('return'), 'bandLabel: full-return mentions return');

// --- estimateRefund ---
eq(estimateRefund('none', 20), null, 'estimateRefund: none → null');
eq(estimateRefund('quarter', null), null, 'estimateRefund: null fare → null');
eq(estimateRefund('quarter', 0), null, 'estimateRefund: zero fare → null');
eq(estimateRefund('quarter', 20), 5, 'estimateRefund: quarter of 20 → 5');
eq(estimateRefund('half', 20), 10, 'estimateRefund: half of 20 → 10');
eq(estimateRefund('full-single', 20), 20, 'estimateRefund: full-single of 20 → 20');
eq(estimateRefund('full-return', 20), 40, 'estimateRefund: full-return of 20 → 40');
eq(estimateRefund('quarter', 7.50), 1.88, 'estimateRefund: quarter of 7.50 → 1.88 (rounded)');
eq(estimateRefund('half', 7.50), 3.75, 'estimateRefund: half of 7.50 → 3.75');
eq(estimateRefund('full-return', 15.40), 30.80, 'estimateRefund: full-return of 15.40 → 30.80');

// --- assessRailJourney ---
{
  const r = assessRailJourney({ delayMinutes: null, singleFare: 20 });
  ok(!r.isEligible && r.band === 'none' && r.delayMinutes === null, 'assess: null delay → not eligible, null minutes');
}
{
  const r = assessRailJourney({ delayMinutes: 10, singleFare: 20 });
  ok(!r.isEligible && r.band === 'none', 'assess: 10 min → not eligible');
}
{
  const r = assessRailJourney({ delayMinutes: 20, singleFare: 20 });
  ok(r.isEligible && r.band === 'quarter' && r.refundEstimate === 5, 'assess: 20 min, £20 → eligible, £5 refund');
}
{
  const r = assessRailJourney({ delayMinutes: 45, singleFare: 30 });
  ok(r.isEligible && r.band === 'half' && r.refundEstimate === 15, 'assess: 45 min, £30 → £15 refund');
}
{
  const r = assessRailJourney({ delayMinutes: 90, singleFare: 50 });
  ok(r.isEligible && r.band === 'full-single' && r.refundEstimate === 50, 'assess: 90 min, £50 → £50 refund');
}
{
  const r = assessRailJourney({ delayMinutes: 150, singleFare: 50 });
  ok(r.isEligible && r.band === 'full-return' && r.refundEstimate === 100, 'assess: 150 min, £50 → £100 refund');
}
{
  const r = assessRailJourney({ delayMinutes: 30, singleFare: null });
  ok(r.isEligible && r.refundEstimate === null, 'assess: eligible but no fare → null refund estimate');
}

// --- hmToMinutes ---
eq(hmToMinutes('00:00'), 0, 'hmToMinutes: midnight = 0');
eq(hmToMinutes('06:30'), 390, 'hmToMinutes: 06:30 = 390');
eq(hmToMinutes('23:59'), 1439, 'hmToMinutes: 23:59 = 1439');
eq(hmToMinutes('9:05'), 545, 'hmToMinutes: single-digit hour');
eq(hmToMinutes('bad'), null, 'hmToMinutes: bad input → null');
eq(hmToMinutes(''), null, 'hmToMinutes: empty → null');

// --- computeDelay ---
eq(computeDelay('10:00', '10:15'), 15, 'computeDelay: 15 min late');
eq(computeDelay('10:00', '10:00'), 0, 'computeDelay: on time = 0');
eq(computeDelay('10:00', '09:58'), -2, 'computeDelay: 2 min early = -2');
eq(computeDelay('23:45', '00:05'), 20, 'computeDelay: overnight service, 20 min late');
eq(computeDelay('23:50', '00:50'), 60, 'computeDelay: overnight, 60 min late');
eq(computeDelay('bad', '10:00'), null, 'computeDelay: bad scheduled → null');
eq(computeDelay('10:00', 'bad'), null, 'computeDelay: bad actual → null');

// --- stations ---
ok(stationByCrs('EUS') !== null, 'stations: EUS resolves');
ok(stationByCrs('BTN') !== null, 'stations: BTN resolves');
ok(stationByCrs('XXX') === null, 'stations: unknown CRS → null');
ok(stationByCrs('eus')?.crs === 'EUS', 'stations: lowercase CRS lookup works');
ok(stationByCrs('EUS')?.name === 'London Euston', 'stations: EUS name is correct');
ok(stationByCrs('BTN')?.name === 'Brighton', 'stations: BTN name is correct');
ok((stationByCrs('EUS')?.operators ?? []).includes('avanti'), 'stations: EUS is Avanti');
ok((stationByCrs('BTN')?.operators ?? []).includes('southern'), 'stations: BTN is Southern');

{
  const results = searchStations('Brighton');
  ok(results.length > 0 && results[0].crs === 'BTN', 'searchStations: Brighton → BTN first');
}
{
  const results = searchStations('London');
  ok(results.length >= 2, 'searchStations: London → multiple results');
}
{
  const results = searchStations('EUS');
  ok(results.length === 1 && results[0].crs === 'EUS', 'searchStations: CRS code exact match');
}
ok(searchStations('').length === 0, 'searchStations: empty query → []');

// --- inferOperator ---
eq(inferOperator('EUS', 'MAN'), 'avanti', 'inferOperator: EUS→MAN = Avanti');
eq(inferOperator('VIC', 'BTN'), 'southern', 'inferOperator: VIC→BTN = Southern');
eq(inferOperator('EUS', 'XXX'), null, 'inferOperator: unknown dest → null');

// --- HSP matchService ---
{
  const result: HspMetricsResult = {
    fromCrs: 'EUS', toCrs: 'MAN', date: '2026-07-07',
    services: [
      { scheduledDepart: '07:03', delayMinutes: 10, cancelled: false, lateArrivalMinutes: 10 },
      { scheduledDepart: '08:03', delayMinutes: 25, cancelled: false, lateArrivalMinutes: 25 },
      { scheduledDepart: '09:03', delayMinutes: null, cancelled: true, lateArrivalMinutes: null },
    ],
  };
  const svc = matchService(result, '08:03');
  ok(svc?.delayMinutes === 25, 'matchService: exact time match returns correct delay');
  const near = matchService(result, '08:10');
  ok(near?.scheduledDepart === '08:03', 'matchService: nearby time match (within 30 min)');
  const far = matchService(result, '11:00');
  ok(far === null, 'matchService: no service within 30 min → null');
  const cancelled = matchService(result, '09:03');
  ok(cancelled?.cancelled === true && cancelled.delayMinutes === null, 'matchService: cancelled service has null delay');
}

console.log(`\ntest-rail-eligibility: all ${passed} assertions passed.`);
