// Tests for transport-spend stats (TfL-24).
//   node --experimental-strip-types src/journeys/test-stats.ts
import { strict as assert } from 'node:assert';
import { computeStats, classifyMode } from './stats.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

test('classifyMode: bus / tube / rail / river / other', () => {
  assert.equal(classifyMode('Bus Journey, Route 282'), 'bus');
  assert.equal(classifyMode('Northolt to White City'), 'tube');
  assert.equal(classifyMode('Foo National Rail to Bar'), 'rail');
  assert.equal(classifyMode('Embankment Pier to North Greenwich Pier'), 'river');
  assert.equal(classifyMode('Auto top-up'), 'other');
});

// A trimmed real-shape blob: banner + header + a bus, a tube leg, and a
// duplicate of the tube leg (must dedupe), plus a £0 aborted touch (skipped).
const BLOB = [
  '# TfL raw statements export — 1 file(s)',
  '# ===== period=10|2025 card=abc =====',
  'Date,Time,Journey,Charge (GBP),Capped,Notes',
  '01/10/2025,08:27,"Bus Journey, Route 282",-1.75,N,',
  '01/10/2025,08:44 - 09:07,Northolt to White City,-3.20,N,',
  '01/10/2025,08:44 - 09:07,Northolt to White City,-3.20,N,', // dup
  '02/10/2025,09:00,Aborted touch,0.00,N,',                    // £0 skip
  '05/11/2025,08:00 - 08:24,Northolt to White City,-3.20,N,',
].join('\n');

test('computeStats: totals, dedupe, £0 skip', () => {
  const s = computeStats(BLOB);
  // 1.75 + 3.20 + 3.20 = 8.15 (dup and £0 excluded)
  assert.equal(s.totalSpend, 8.15);
  assert.equal(s.journeyCount, 3);
  assert.equal(s.earliestDate, '2025-10-01');
  assert.equal(s.latestDate, '2025-11-05');
});

test('computeStats: byMode split', () => {
  const s = computeStats(BLOB);
  const bus = s.byMode.find(m => m.mode === 'bus')!;
  const tube = s.byMode.find(m => m.mode === 'tube')!;
  assert.equal(bus.spend, 1.75);
  assert.equal(bus.count, 1);
  assert.equal(tube.spend, 6.4);
  assert.equal(tube.count, 2);
  // sorted spend-descending → tube first
  assert.equal(s.byMode[0].mode, 'tube');
});

test('computeStats: byMonth ascending', () => {
  const s = computeStats(BLOB);
  assert.deepEqual(s.byMonth.map(m => m.month), ['2025-10', '2025-11']);
  assert.equal(s.byMonth[0].spend, 4.95); // Oct: 1.75 + 3.20
  assert.equal(s.byMonth[1].spend, 3.20); // Nov
});

test('computeStats: entities unescaped inline (raw &quot; bus row)', () => {
  const s = computeStats([
    'Date,Time,Journey,Charge (GBP)',
    '01/10/2025,08:27,&quot;Bus Journey, Route 282&quot;,-1.75',
  ].join('\n'));
  assert.equal(s.totalSpend, 1.75);
  assert.equal(s.byMode[0].mode, 'bus');
});

test('computeStats: empty input', () => {
  const s = computeStats('');
  assert.equal(s.totalSpend, 0);
  assert.equal(s.journeyCount, 0);
  assert.equal(s.earliestDate, null);
  assert.deepEqual(s.byMode, []);
});

console.log(`\n${n} tests passed`);
