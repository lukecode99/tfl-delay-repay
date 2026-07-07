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
  migrateRailSchema,
  setRailClaimStatus,
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
  ticketPricePence: 4550,   // £45.50
  ticketType: 'single',
  ticketRef: 'X3K9P',
  claimDeadline: null,       // computed by insertRailJourney
  claimedAt: null,
  claimStatus: 'pending',
  importedAt: NOW,
};

test('schema creation is idempotent', () => {
  const d = makeDb();
  ensureRailSchema(d);
  ensureRailSchema(d); // second call must not throw
  ok(true, 'schema: ensureRailSchema is idempotent');
});

test('insert and retrieve — new fields', () => {
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
  eq(row!.ticketPricePence, 4550, 'insert: ticketPricePence persisted');
  eq(row!.ticketType, 'single', 'insert: ticketType persisted');
  eq(row!.ticketRef, 'X3K9P', 'insert: ticketRef persisted');
  ok(row!.claimDeadline === '2026-08-04', 'insert: claimDeadline = departure + 28 days');
  ok(row!.claimedAt === null, 'insert: claimedAt starts null');
  eq(row!.claimStatus, 'pending', 'insert: claimStatus defaults to pending');
});

test('claimDeadline computed as departure_date + 28 days', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const j: Omit<RailJourney, 'id'> = { ...BASE, departureDate: '2026-12-31' };
  const id = insertRailJourney(d, j, NOW)!;
  const row = getRailJourney(d, id)!;
  ok(row.claimDeadline === '2027-01-28', 'claimDeadline: wraps into next year');
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

test('markRailClaimed sets claimedAt and claimStatus', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const id = insertRailJourney(d, BASE, NOW)!;
  const claimTime = '2026-07-08T12:00:00.000Z';
  markRailClaimed(d, id, claimTime);
  const claimed = getRailJourney(d, id);
  eq(claimed!.claimedAt, claimTime, 'claim: claimedAt set correctly');
  eq(claimed!.claimStatus, 'filed', 'claim: claimStatus → filed');
  unmarkRailClaimed(d, id);
  const unclaimed = getRailJourney(d, id);
  ok(unclaimed!.claimedAt === null, 'unclaim: claimedAt cleared to null');
  eq(unclaimed!.claimStatus, 'pending', 'unclaim: claimStatus → pending');
});

test('setRailClaimStatus', () => {
  const d = makeDb();
  ensureRailSchema(d);
  const id = insertRailJourney(d, BASE, NOW)!;
  setRailClaimStatus(d, id, 'paid');
  eq(getRailJourney(d, id)!.claimStatus, 'paid', 'status: set to paid');
  setRailClaimStatus(d, id, 'rejected');
  eq(getRailJourney(d, id)!.claimStatus, 'rejected', 'status: set to rejected');
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
    ticketPricePence: null,
    ticketType: null,
    ticketRef: null,
    claimDeadline: null,
    claimedAt: null,
    claimStatus: 'pending',
    importedAt: NOW,
  };
  const id = insertRailJourney(d, minimal, NOW)!;
  const row = getRailJourney(d, id)!;
  ok(row.actualDepart === null, 'nullable: actualDepart null preserved');
  ok(row.actualArrive === null, 'nullable: actualArrive null preserved');
  ok(row.delayMinutes === null, 'nullable: delayMinutes null preserved');
  ok(row.ticketPricePence === null, 'nullable: ticketPricePence null preserved');
  ok(row.ticketType === null, 'nullable: ticketType null preserved');
  ok(row.ticketRef === null, 'nullable: ticketRef null preserved');
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

test('migration: adds columns to old schema and populates claim_deadline', () => {
  const d = makeDb();
  // Simulate an old install: create table without new columns
  d.execSync(`
    CREATE TABLE rail_journeys (
      id INTEGER PRIMARY KEY,
      origin_crs TEXT NOT NULL,
      destination_crs TEXT NOT NULL,
      departure_date TEXT NOT NULL,
      scheduled_depart TEXT NOT NULL,
      actual_depart TEXT,
      scheduled_arrive TEXT,
      actual_arrive TEXT,
      delay_minutes INTEGER,
      operator TEXT NOT NULL,
      single_fare REAL,
      claimed_at TEXT,
      imported_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_journeys_dedupe
      ON rail_journeys (origin_crs, destination_crs, departure_date, scheduled_depart, operator);
  `);
  // Insert a row with old schema
  d.runSync(
    `INSERT INTO rail_journeys (origin_crs, destination_crs, departure_date, scheduled_depart, operator, single_fare, claimed_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'EUS', 'MAN', '2026-07-07', '07:03', 'avanti', 45.50, '2026-07-08T12:00:00.000Z', NOW,
  );
  // Run migration
  migrateRailSchema(d);
  // Verify new columns exist and are populated
  const row = d.getFirstSync<Record<string, unknown>>('SELECT * FROM rail_journeys');
  ok(row !== null, 'migration: row still exists after migration');
  ok(row!.ticket_price_pence === 4550, 'migration: single_fare → ticket_price_pence (£45.50 → 4550p)');
  ok(row!.claim_deadline === '2026-08-04', 'migration: claim_deadline = departure_date + 28 days');
  ok(row!.claim_status === 'filed', 'migration: claim_status = filed (was claimed_at set)');
});

test('migration: pending status for unclaimed rows', () => {
  const d = makeDb();
  d.execSync(`
    CREATE TABLE rail_journeys (
      id INTEGER PRIMARY KEY,
      origin_crs TEXT NOT NULL, destination_crs TEXT NOT NULL,
      departure_date TEXT NOT NULL, scheduled_depart TEXT NOT NULL,
      operator TEXT NOT NULL, single_fare REAL, claimed_at TEXT,
      imported_at TEXT NOT NULL
    );
  `);
  d.runSync(
    `INSERT INTO rail_journeys (origin_crs, destination_crs, departure_date, scheduled_depart, operator, claimed_at, imported_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    'VIC', 'BTN', '2026-07-07', '10:00', 'southern', NOW,
  );
  migrateRailSchema(d);
  const row = d.getFirstSync<Record<string, unknown>>('SELECT * FROM rail_journeys');
  ok(row!.claim_status === 'pending', 'migration: unclaimed rows get pending status');
  ok(row!.ticket_price_pence === null, 'migration: null single_fare → null ticket_price_pence');
});

test('migration is idempotent on fresh schema', () => {
  const d = makeDb();
  ensureRailSchema(d);
  migrateRailSchema(d); // should not throw on a fresh schema
  migrateRailSchema(d); // idempotent
  ok(true, 'migration: idempotent on fresh schema');
});

for (const { name, fn } of tests) {
  fn();
  console.log(`  ✓ ${name}`);
}
console.log(`\ntest-rail-db: ${tests.length} tests, ${passed} assertions passed.`);
