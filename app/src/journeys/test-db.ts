// Store-core tests (TfL-8) — run with:
//   node --experimental-strip-types src/journeys/test-db.ts
// Exercises the real SQL against node:sqlite via a DbLike adapter, so the
// insert/upgrade/migration behaviour tested here is exactly what expo-sqlite
// executes on device.
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import type { ParsedJourney } from './parse';
import {
  type DbLike,
  ensureJourneySchema,
  insertJourneysCore,
  migrateLegacyImportRows,
} from './store-core.ts';

function makeDb(): DbLike {
  const raw = new DatabaseSync(':memory:');
  return {
    execSync: (sql: string) => { raw.exec(sql); },
    runSync: (sql: string, ...params: any[]) => {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    getAllSync: <T,>(sql: string, ...params: any[]) => raw.prepare(sql).all(...params) as T[],
    getFirstSync: <T,>(sql: string, ...params: any[]) => (raw.prepare(sql).get(...params) as T) ?? null,
    withTransactionSync: (fn: () => void) => {
      raw.exec('BEGIN');
      try { fn(); raw.exec('COMMIT'); }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

function journey(over: Partial<ParsedJourney> = {}): ParsedJourney {
  return {
    card: 'card-1',
    date: '2026-06-30',
    tapInTime: '08:55',
    tapOutTime: '09:22',
    origin: 'Brixton',
    destination: 'Kings Cross',
    charge: 3.4,
    incomplete: false,
    rawAction: 'Brixton to Kings Cross',
    ...over,
  };
}

// A row as the pre-hotfix parser stored it: no times, negative charge,
// flagged incomplete.
function brokenJourney(over: Partial<ParsedJourney> = {}): ParsedJourney {
  return journey({
    tapInTime: null,
    tapOutTime: null,
    charge: -3.4,
    incomplete: true,
    ...over,
  });
}

const NOW = '2026-07-04T12:00:00.000Z';
type Row = { id: number; tap_in_time: string | null; tap_out_time: string | null; charge: number; incomplete: number; imported_at: string };
const allRows = (d: DbLike) => d.getAllSync<Row>('SELECT * FROM journeys ORDER BY id');

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('fresh insert counts inserted + incomplete', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  const s = insertJourneysCore(d, [journey(), journey({ origin: 'Angel', tapInTime: null, tapOutTime: null, incomplete: true, destination: null })], NOW);
  assert.deepEqual(s, { inserted: 2, duplicates: 0, incomplete: 1, upgraded: 0 });
  assert.equal(allRows(d).length, 2);
});

test('re-import of identical statement is all duplicates', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [journey()], NOW);
  const s = insertJourneysCore(d, [journey()], NOW);
  assert.deepEqual(s, { inserted: 0, duplicates: 1, incomplete: 0, upgraded: 0 });
  assert.equal(allRows(d).length, 1);
});

test('broken row upgrades in place — id preserved, times/charge fixed', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  const before = allRows(d)[0];
  assert.equal(before.tap_in_time, null);

  const s = insertJourneysCore(d, [journey()], NOW);
  assert.deepEqual(s, { inserted: 0, duplicates: 0, incomplete: 0, upgraded: 1 });
  const rows = allRows(d);
  assert.equal(rows.length, 1, 'no duplicate row created');
  assert.equal(rows[0].id, before.id, 'row id survives the upgrade');
  assert.equal(rows[0].tap_in_time, '08:55');
  assert.equal(rows[0].tap_out_time, '09:22');
  assert.equal(rows[0].charge, 3.4);
  assert.equal(rows[0].incomplete, 0);
});

test('upgrade preserves an existing claim on the broken row', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  const id = allRows(d)[0].id;
  d.execSync('CREATE TABLE IF NOT EXISTS claims (journey_id INTEGER PRIMARY KEY, claimed_at TEXT NOT NULL);');
  d.runSync('INSERT INTO claims (journey_id, claimed_at) VALUES (?, ?)', id, NOW);

  insertJourneysCore(d, [journey()], NOW);
  const claim = d.getFirstSync<{ journey_id: number }>('SELECT journey_id FROM claims');
  assert.equal(claim?.journey_id, id, 'claim still points at the (upgraded) row');
  assert.equal(allRows(d)[0].tap_in_time, '08:55');
});

test('upgrade skipped when the timed row already exists — counted as duplicate', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  // Both a broken and a timed row exist (Luke's build-4 state after one re-import
  // on the old insert path).
  insertJourneysCore(d, [brokenJourney()], NOW);
  d.runSync(
    `INSERT INTO journeys (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
     VALUES ('card-1', '2026-06-30', '08:55', '09:22', 'Brixton', 'Kings Cross', 3.4, 0, 'Brixton to Kings Cross', ?)`, NOW,
  );
  const s = insertJourneysCore(d, [journey()], NOW);
  assert.deepEqual(s, { inserted: 0, duplicates: 1, incomplete: 0, upgraded: 0 });
  assert.equal(allRows(d).length, 2, 'UPDATE OR IGNORE must not collapse rows mid-insert');
});

test('two same-day same-origin journeys: first upgrades the broken row, second inserts', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  const s = insertJourneysCore(d, [journey(), journey({ tapInTime: '18:10', tapOutTime: '18:40' })], NOW);
  assert.deepEqual(s, { inserted: 1, duplicates: 0, incomplete: 0, upgraded: 1 });
  const rows = allRows(d);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.tap_in_time).sort(), ['08:55', '18:10']);
});

test('migration flips negative stored charges positive', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney(), journey({ origin: 'Angel', charge: 2.8 })], NOW);
  const r = migrateLegacyImportRows(d);
  assert.equal(r.chargesFixed, 1);
  assert.deepEqual(allRows(d).map(x => x.charge).sort(), [2.8, 3.4]);
  // idempotent
  const r2 = migrateLegacyImportRows(d);
  assert.equal(r2.chargesFixed, 0);
});

test('migration removes broken row when a timed sibling exists, remapping its claim', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  const brokenId = allRows(d)[0].id;
  d.runSync(
    `INSERT INTO journeys (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
     VALUES ('card-1', '2026-06-30', '08:55', '09:22', 'Brixton', 'Kings Cross', 3.4, 0, 'Brixton to Kings Cross', ?)`, NOW,
  );
  const timedId = allRows(d).find(x => x.tap_in_time !== null)!.id;
  d.execSync('CREATE TABLE IF NOT EXISTS claims (journey_id INTEGER PRIMARY KEY, claimed_at TEXT NOT NULL);');
  d.runSync('INSERT INTO claims (journey_id, claimed_at) VALUES (?, ?)', brokenId, NOW);

  const r = migrateLegacyImportRows(d);
  assert.equal(r.duplicatesRemoved, 1);
  const rows = allRows(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, timedId, 'timed row kept');
  const claim = d.getFirstSync<{ journey_id: number }>('SELECT journey_id FROM claims');
  assert.equal(claim?.journey_id, timedId, 'claim remapped to the timed row');
});

test('migration: when both rows are claimed, the timed row\'s claim wins', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  const brokenId = allRows(d)[0].id;
  d.runSync(
    `INSERT INTO journeys (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
     VALUES ('card-1', '2026-06-30', '08:55', '09:22', 'Brixton', 'Kings Cross', 3.4, 0, 'Brixton to Kings Cross', ?)`, NOW,
  );
  const timedId = allRows(d).find(x => x.tap_in_time !== null)!.id;
  d.execSync('CREATE TABLE IF NOT EXISTS claims (journey_id INTEGER PRIMARY KEY, claimed_at TEXT NOT NULL);');
  d.runSync('INSERT INTO claims (journey_id, claimed_at) VALUES (?, ?)', brokenId, '2026-07-01T00:00:00Z');
  d.runSync('INSERT INTO claims (journey_id, claimed_at) VALUES (?, ?)', timedId, '2026-07-02T00:00:00Z');

  migrateLegacyImportRows(d);
  const claims = d.getAllSync<{ journey_id: number; claimed_at: string }>('SELECT * FROM claims');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].journey_id, timedId);
  assert.equal(claims[0].claimed_at, '2026-07-02T00:00:00Z');
});

test('migration leaves genuinely incomplete journeys (no timed sibling) alone', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney({ destination: null })], NOW);
  const r = migrateLegacyImportRows(d);
  assert.equal(r.duplicatesRemoved, 0);
  assert.equal(allRows(d).length, 1);
});

test('migration matches sibling on destination too — different route not treated as duplicate', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW); // Brixton → Kings Cross, broken
  d.runSync(
    `INSERT INTO journeys (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
     VALUES ('card-1', '2026-06-30', '10:00', '10:30', 'Brixton', 'Oxford Circus', 2.8, 0, 'Brixton to Oxford Circus', ?)`, NOW,
  );
  const r = migrateLegacyImportRows(d);
  assert.equal(r.duplicatesRemoved, 0, 'different destination is a different journey');
  assert.equal(allRows(d).length, 2);
});

test('migration works before claims/db.ts has ever created the claims table', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  insertJourneysCore(d, [brokenJourney()], NOW);
  d.runSync(
    `INSERT INTO journeys (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
     VALUES ('card-1', '2026-06-30', '08:55', '09:22', 'Brixton', 'Kings Cross', 3.4, 0, 'Brixton to Kings Cross', ?)`, NOW,
  );
  const r = migrateLegacyImportRows(d); // must not throw on missing claims table
  assert.equal(r.duplicatesRemoved, 1);
  assert.equal(allRows(d).length, 1);
});

test('end-to-end build-4 scenario: broken import → migration → re-import is clean', () => {
  const d = makeDb();
  ensureJourneySchema(d);
  // Build 4: old parser stored the whole statement broken.
  insertJourneysCore(d, [
    brokenJourney(),
    brokenJourney({ origin: 'Kings Cross', destination: 'Brixton', charge: -3.4, rawAction: 'Kings Cross to Brixton' }),
  ], NOW);
  // App update ships: migration runs at open (nothing to dedupe yet, fixes charges).
  const m1 = migrateLegacyImportRows(d);
  assert.equal(m1.chargesFixed, 2);
  // Luke re-imports the same statement, now parsed correctly.
  const s = insertJourneysCore(d, [
    journey(),
    journey({ origin: 'Kings Cross', destination: 'Brixton', tapInTime: '17:45', tapOutTime: '18:12', rawAction: 'Kings Cross to Brixton' }),
  ], NOW);
  assert.deepEqual(s, { inserted: 0, duplicates: 0, incomplete: 0, upgraded: 2 });
  const rows = allRows(d);
  assert.equal(rows.length, 2, 'zero ?? duplicates after re-import');
  assert.ok(rows.every(x => x.tap_in_time !== null && x.charge > 0));
});

console.log(`test-db: all ${passed} tests passed`);
