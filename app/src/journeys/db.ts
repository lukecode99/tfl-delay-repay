// Local journey store — thin expo-sqlite binding over store-core.ts, which
// holds the SQL (schema, dedupe, insert/upgrade, legacy-import migration) as
// pure functions so it can be tested under plain node (see test-db.ts).
// Dedupe is enforced by a UNIQUE index on (card, date, tap_in_time, origin) —
// the key from the TfL-3 card spec — so re-importing an overlapping statement
// inserts only the new rows.
import * as SQLite from 'expo-sqlite';
import type { ParsedJourney, ParsedRefund } from './parse';
import {
  ensureJourneySchema,
  ensureMetaSchema,
  ensureRefundSchema,
  getMetaCore,
  insertJourneysCore,
  insertRefundsCore,
  migrateLegacyImportRows,
  setMetaCore,
  totalRefundsCore,
  type ImportSummary,
  type RefundInsertSummary,
} from './store-core';

export type { ImportSummary, RefundInsertSummary } from './store-core';

export interface StoredJourney extends ParsedJourney {
  id: number;
  importedAt: string;
}

let db: SQLite.SQLiteDatabase | null = null;

export function openJourneyDb(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync('journeys.db');
  ensureJourneySchema(db);
  ensureMetaSchema(db);
  ensureRefundSchema(db);
  migrateLegacyImportRows(db); // idempotent TfL-8 cleanup of pre-hotfix rows
  return db;
}

export function getMeta(key: string): string | null {
  return getMetaCore(openJourneyDb(), key);
}

export function setMeta(key: string, value: string): void {
  setMetaCore(openJourneyDb(), key, value);
}

/** Card ids of every stored journey (with repeats) — TfL-10 uses the most
 * frequent as the default card for auto-fetched statements. */
export function listCards(): string[] {
  return openJourneyDb().getAllSync<{ card: string }>('SELECT card FROM journeys').map(r => r.card);
}

export function insertJourneys(journeys: ParsedJourney[]): ImportSummary {
  return insertJourneysCore(openJourneyDb(), journeys, new Date().toISOString());
}

export function insertRefunds(refunds: ParsedRefund[], card: string, period = ''): RefundInsertSummary {
  return insertRefundsCore(openJourneyDb(), refunds, card, period, new Date().toISOString());
}

export function totalReceivedRefunds(): number {
  return totalRefundsCore(openJourneyDb());
}

const ROW_TO_JOURNEY = (r: any): StoredJourney => ({
  id: r.id,
  card: r.card,
  date: r.date,
  tapInTime: r.tap_in_time,
  tapOutTime: r.tap_out_time,
  origin: r.origin,
  destination: r.destination,
  charge: r.charge,
  incomplete: !!r.incomplete,
  rawAction: r.raw_action,
  importedAt: r.imported_at,
});

export function listJourneys(limit = 200): StoredJourney[] {
  const d = openJourneyDb();
  return d.getAllSync<any>(
    `SELECT * FROM journeys ORDER BY date DESC, tap_in_time DESC LIMIT ?`, limit,
  ).map(ROW_TO_JOURNEY);
}

/** Load all journeys from the DB (no row cap). Used for the 13-month UI filter. */
export function listAllJourneys(): StoredJourney[] {
  const d = openJourneyDb();
  return d.getAllSync<any>(
    `SELECT * FROM journeys ORDER BY date DESC, tap_in_time DESC`,
  ).map(ROW_TO_JOURNEY);
}

export function journeyCount(): number {
  const d = openJourneyDb();
  return d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM journeys')?.n ?? 0;
}
