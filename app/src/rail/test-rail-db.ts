// Rail DB store-core tests — run with:
//   node --experimental-strip-types src/rail/test-rail-db.ts
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { DbLike } from '../journeys/store-core.ts';
import {
  countRailJourneys,
  ensureRailSchema,
  getRailJourney,
  insertRailJourney,
  listRailJourneys,
  markRailClaimed,
  type RailJourney,
  unmarkRailClaimed,
  updateRailActuals,
} from './store-core.ts';

let passed = 0;
const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void) { tests.push({ name, fn }); }
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
}
function eq<T>(a: T, b: T, msg: string) {
  assert.deepStrictEqual(a, b, msg);
  passed++;
}

function makeDb(): DbLike {
  const raw = new DatabaseSync(':memory:');
  return {
    execSync: sql => raw.exec(sql),
    runSync: (sql, ...p) => raw.prepare(sql).run(...p) as { changes: number },
    getAllSync: <T>(sql: string, ...p: unknown[]) => raw.prepare(sql).all(...p) as T[],
    getFirstSync: <T>(sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as T | undefined) ?? null,
    withTransactionSync: fn => { const tx = raw.prepare('BEGIN'); tx.run(); try { fn(); raw.prepare('COMMIT').run(); } catch (e) { raw.prepare('ROLLBACK').run(); throw e; } },
  };
}

const NOW = '2026-07-08T10:00:00.000Z';

const BASE: Omit<RailJourney, 'id'> = {
  originCrs: 'EUS',
  destinationCrs: 'MAN',
  departureDate: '2026-07-07',
  scheduledDepart: '07:03',
  actualDepart: '07:05',
  scheduledArrive: '09:18',
  actualArrive: '09:43',
  delayMinutes: 25,
  operator: 'avanti',
  singleFare: 45.50,
  claimedAt: null,
  importedAt: NOW,
};

test('schema creation is idempotent', () => {
  const d = makeDb();
  ensureRailSchema(d);
  ensureRailSchema(d); // second call must not throw
  ok(true, 'schema: ensureRailSchema is idempotent');
});

test('insert and retrieve', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const id = insertRailJourney(d, BASE, NOW);
  ok(id !== null, 'insert: returns a non-null id');
  const row = getRailJourney(d, id!);
  ok(row !== null, 'insert: getRailJourney finds the row');
  eq(row!.originCrs, 'EUS', 'insert: originCrs persisted');
  eq(row!.destinationCrs, 'MAN', 'insert: destinationCrs persisted');
  eq(row!.scheduledDepart, '07:03', 'insert: scheduledDepart persisted');
  eq(row!.delayMinutes, 25, 'insert: delayMinutes persisted');
  eq(row!.operator, 'avanti', 'insert: operator persisted');
  eq(row!.singleFare, 45.50, 'insert: singleFare persisted');
  ok(row!.claimedAt === null, 'insert: claimedAt starts null');
});

test('dedupe: same journey not double-inserted', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const id1 = insertRailJourney(d, BASE, NOW);
  const id2 = insertRailJourney(d, BASE, NOW);
  ok(id1 !== null, 'dedupe: first insert succeeds');
  ok(id2 === null, 'dedupe: duplicate insert returns null');
  eq(countRailJourneys(d), 1, 'dedupe: only one row in DB');
});

test('distinct journeys can coexist', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const j2: Omit<RailJourney, 'id'> = { ...BASE, scheduledDepart: '08:03' };
  const j3: Omit<RailJourney, 'id'> = { ...BASE, departureDate: '2026-07-08', scheduledDepart: '07:03' };
  insertRailJourney(d, BASE, NOW);
  insertRailJourney(d, j2, NOW);
  insertRailJourney(d, j3, NOW);
  eq(countRailJourneys(d), 3, 'distinct: three different journeys coexist');
});

test('listRailJourneys returns most recent first', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const older: Omit<RailJourney, 'id'> = { ...BASE, departureDate: '2026-07-06' };
  const newer: Omit<RailJourney, 'id'> = { ...BASE, departureDate: '2026-07-08' };
  insertRailJourney(d, BASE, NOW);
  insertRailJourney(d, older, NOW);
  insertRailJourney(d, newer, NOW);
  const rows = listRailJourneys(d, 10);
  eq(rows[0].departureDate, '2026-07-08', 'list: most recent date first');
  eq(rows[2].departureDate, '2026-07-06', 'list: oldest date last');
});

test('listRailJourneys respects limit', () => {
  const d = makeDb();
  ensureRailSchema(d);
  for (let i = 0; i < 5; i++) {
    const depart = String(7 + i).padStart(2, '0') + ':03';
    insertRailJourney(d, { ...BASE, scheduledDepart: depart }, NOW);
  }
  eq(countRailJourneys(d), 5, 'limit: 5 inserted');
  const rows = listRailJourneys(d, 3);
  eq(rows.length, 3, 'limit: listRailJourneys respects limit param');
});

test('markRailClaimed and unmarkRailClaimed', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const id = insertRailJourney(d, BASE, NOW)!;
  const claimTime = '2026-07-08T12:00:00.000Z';
  markRailClaimed(d, id, claimTime);
  const claimed = getRailJourney(d, id);
  eq(claimed!.claimedAt, claimTime, 'claim: claimedAt set correctly');
  unmarkRailClaimed(d, id);
  const unclaimed = getRailJourney(d, id);
  ok(unclaimed!.claimedAt === null, 'unclaim: claimedAt cleared to null');
});

test('updateRailActuals', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const noActuals: Omit<RailJourney, 'id'> = {
    ...BASE,
    actualDepart: null,
    actualArrive: null,
    delayMinutes: null,
  };
  const id = insertRailJourney(d, noActuals, NOW)!;
  const before = getRailJourney(d, id)!;
  ok(before.delayMinutes === null, 'actuals: starts null');
  updateRailActuals(d, id, '07:05', '09:43', 25);
  const after = getRailJourney(d, id)!;
  eq(after.actualDepart, '07:05', 'actuals: actualDepart updated');
  eq(after.actualArrive, '09:43', 'actuals: actualArrive updated');
  eq(after.delayMinutes, 25, 'actuals: delayMinutes updated');
});

test('nullable fields survive round-trip', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const minimal: Omit<RailJourney, 'id'> = {
    originCrs: 'VIC',
    destinationCrs: 'BTN',
    departureDate: '2026-07-07',
    scheduledDepart: '10:00',
    actualDepart: null,
    scheduledArrive: null,
    actualArrive: null,
    delayMinutes: null,
    operator: 'southern',
    singleFare: null,
    claimedAt: null,
    importedAt: NOW,
  };
  const id = insertRailJourney(d, minimal, NOW)!;
  const row = getRailJourney(d, id)!;
  ok(row.actualDepart === null, 'nullable: actualDepart null preserved');
  ok(row.actualArrive === null, 'nullable: actualArrive null preserved');
  ok(row.delayMinutes === null, 'nullable: delayMinutes null preserved');
  ok(row.singleFare === null, 'nullable: singleFare null preserved');
});

test('countRailJourneys', () => {
  const d = makeDb();
  ensureRailSchema(d);
  eq(countRailJourneys(d), 0, 'count: empty table = 0');
  insertRailJourney(d, BASE, NOW);
  eq(countRailJourneys(d), 1, 'count: after insert = 1');
});

test('getRailJourney unknown id returns null', () => {
  const d = makeDb();
  ensureRailSchema(d);
  ok(getRailJourney(d, 999) === null, 'getRailJourney: unknown id → null');
});

for (const { name, fn } of tests) {
  fn();
  console.log(`  ✓ ${name}`);
}
console.log(`\ntest-rail-db: ${tests.length} tests, ${passed} assertions passed.`);
