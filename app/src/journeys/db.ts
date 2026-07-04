// Local journey store (expo-sqlite). Dedupe is enforced by a UNIQUE index on
// (card, date, tap_in_time, origin) — the key from the TfL-3 card spec — so
// re-importing an overlapping statement inserts only the new rows.
import * as SQLite from 'expo-sqlite';
import { ParsedJourney } from './parse';

export interface StoredJourney extends ParsedJourney {
  id: number;
  importedAt: string;
}

export interface ImportSummary {
  inserted: number;
  duplicates: number;
  incomplete: number; // incomplete journeys among the inserted rows
}

let db: SQLite.SQLiteDatabase | null = null;

export function openJourneyDb(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync('journeys.db');
  db.execSync(`
    CREATE TABLE IF NOT EXISTS journeys (
      id INTEGER PRIMARY KEY,
      card TEXT NOT NULL,
      date TEXT NOT NULL,
      tap_in_time TEXT,
      tap_out_time TEXT,
      origin TEXT NOT NULL,
      destination TEXT,
      charge REAL,
      incomplete INTEGER NOT NULL DEFAULT 0,
      raw_action TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_dedupe
      ON journeys (card, date, IFNULL(tap_in_time, ''), origin);
    CREATE INDEX IF NOT EXISTS idx_journeys_date ON journeys (date);
  `);
  return db;
}

export function insertJourneys(journeys: ParsedJourney[]): ImportSummary {
  const d = openJourneyDb();
  const summary: ImportSummary = { inserted: 0, duplicates: 0, incomplete: 0 };
  const now = new Date().toISOString();
  d.withTransactionSync(() => {
    for (const j of journeys) {
      const res = d.runSync(
        `INSERT OR IGNORE INTO journeys
           (card, date, tap_in_time, tap_out_time, origin, destination, charge, incomplete, raw_action, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        j.card, j.date, j.tapInTime, j.tapOutTime, j.origin, j.destination,
        j.charge, j.incomplete ? 1 : 0, j.rawAction, now,
      );
      if (res.changes > 0) {
        summary.inserted++;
        if (j.incomplete) summary.incomplete++;
      } else {
        summary.duplicates++;
      }
    }
  });
  return summary;
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
