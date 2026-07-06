// Local journey store — thin expo-sqlite binding over store-core.ts, which
// holds the SQL (schema, dedupe, insert/upgrade, legacy-import migration) as
// pure functions so it can be tested under plain node (see test-db.ts).
// Dedupe is enforced by a UNIQUE index on (card, date, tap_in_time, origin) —
// the key from the TfL-3 card spec — so re-importing an overlapping statement
// inserts only the new rows.
import * as SQLite from 'expo-sqlite';
import { ParsedJourney } from './parse';
import {
  ensureJourneySchema,
  ensureMetaSchema,
  getMetaCore,
  insertJourneysCore,
  migrateLegacyImportRows,
  setMetaCore,
  type ImportSummary,
} from './store-core';

export type { ImportSummary } from './store-core';

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

export function listJourneys(limit = 200): StoredJourney[] {
  const d = openJourneyDb();
  const rows = d.getAllSync<any>(
    `SELECT * FROM journeys ORDER BY date DESC, tap_in_time DESC LIMIT ?`, limit,
  );
  return rows.map(r => ({
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
  }));
}

export function journeyCount(): number {
  const d = openJourneyDb();
  return d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM journeys')?.n ?? 0;
}
