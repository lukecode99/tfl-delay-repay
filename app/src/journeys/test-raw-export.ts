// Tests for the raw-statement export combine step (TfL-23).
//   node --experimental-strip-types src/journeys/test-raw-export.ts
import { strict as assert } from 'node:assert';
import { combineRawStatements, RAW_STATEMENTS_FILE } from './raw-export.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

test('combines multiple statements with period/card banners', () => {
  const out = combineRawStatements([
    { period: '6|2026', card: 'abc123', text: 'Date,Journey,Charge\n01/06,X to Y,2.80' },
    { period: '5|2026', card: 'abc123', text: 'Date,Journey,Charge\n02/05,A to B,3.10' },
  ]);
  assert.ok(out.includes('# TfL raw statements export — 2 file(s)'));
  assert.ok(out.includes('# ===== period=6|2026 card=abc123 ====='));
  assert.ok(out.includes('# ===== period=5|2026 card=abc123 ====='));
  assert.ok(out.includes('01/06,X to Y,2.80'));
  assert.ok(out.includes('02/05,A to B,3.10'));
});

test('preserves each file header row (both headers survive)', () => {
  const out = combineRawStatements([
    { period: '6|2026', text: 'Date,Journey,Charge\nrow1' },
    { period: '5|2026', text: 'Date,Journey,Charge\nrow2' },
  ]);
  assert.equal((out.match(/Date,Journey,Charge/g) ?? []).length, 2);
});

test('keeps an empty statement as a clue, with unknown labels', () => {
  const out = combineRawStatements([{ text: '' }]);
  assert.ok(out.includes('# ===== period=? card=? ====='));
  assert.ok(out.includes('1 file(s)'));
});

test('handles the empty set', () => {
  const out = combineRawStatements([]);
  assert.ok(out.includes('0 file(s)'));
});

test('export filename constant is a .csv', () => {
  assert.ok(RAW_STATEMENTS_FILE.endsWith('.csv'));
});

console.log(`\n${n} tests passed`);
