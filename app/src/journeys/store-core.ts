// Journey store core (TfL-8) — schema, insert and legacy-import migration as
// pure functions over a minimal db handle, so the SQL is testable under plain
// node (node:sqlite adapter in test-db.ts) while db.ts binds it to expo-sqlite.
import type { ParsedJourney } from './parse';

/** The subset of expo-sqlite's SQLiteDatabase this module needs. */
export interface DbLike {
  execSync(sql: string): void;
  runSync(sql: string, ...params: any[]): { changes: number };
  getAllSync<T>(sql: string, ...params: any[]): T[];
  getFirstSync<T>(sql: string, ...params: any[]): T | null;
  withTransactionSync(fn: () => void): void;
}

export interface ImportSummary {
  inserted: number;
  duplicates: number;
  incomplete: number; // incomplete journeys among the inserted rows
  upgraded: number; // broken pre-hotfix rows fixed in place by this import
}

export function ensureJourneySchema(d: DbLike): void {
  d.execSync(`
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
}

/**
 * One-shot cleanup for statements imported before the parse hotfix (0d8f45e),
 * which stored contactless web-export journeys with null tap times and the
 * export's negative charge sign. Idempotent — runs at every db open.
 *
 * 1. Flip negative stored charges positive (the hotfix made this parse-time only).
 * 2. If a broken row (null tap-in) already has a timed sibling from a re-import,
 *    keep the timed row, remap any claim onto it, and drop the broken row.
 *    Claims reference journeys by row id, so the remap preserves the linkage;
 *    if BOTH rows were somehow claimed, the timed row's claim wins.
 */
export function migrateLegacyImportRows(d: DbLike): { chargesFixed: number; duplicatesRemoved: number } {
  const result = { chargesFixed: 0, duplicatesRemoved: 0 };
  d.withTransactionSync(() => {
    result.chargesFixed = d.runSync('UPDATE journeys SET charge = ABS(charge) WHERE charge < 0').changes;

    // Claims may not exist yet (claims/db.ts creates the table lazily) — create
    // the TfL-6 base shape so the remap below always has a table to work on.
    d.execSync(`CREATE TABLE IF NOT EXISTS claims (
      journey_id INTEGER PRIMARY KEY,
      claimed_at TEXT NOT NULL
    );`);

    const broken = d.getAllSync<{ id: number; card: string; date: string; origin: string; destination: string | null }>(
      'SELECT id, card, date, origin, destination FROM journeys WHERE tap_in_time IS NULL',
    );
    for (const b of broken) {
      const sibling = d.getFirstSync<{ id: number }>(
        `SELECT id FROM journeys
         WHERE card = ? AND date = ? AND origin = ? AND IFNULL(destination, '') = IFNULL(?, '')
           AND tap_in_time IS NOT NULL
         ORDER BY id LIMIT 1`,
        b.card, b.date, b.origin, b.destination,
      );
      if (!sibling) continue;
      d.runSync('UPDATE OR IGNORE claims SET journey_id = ? WHERE journey_id = ?', sibling.id, b.id);
      d.runSync('DELETE FROM claims WHERE journey_id = ?', b.id);
      d.runSync('DELETE FROM journeys WHERE id = ?', b.id);
      result.duplicatesRemoved++;
    }
  });
  return result;
}

// App-level key/value scraps (TfL-10: last auto-fetch stamp). Kept in the
// journeys db so there's one store to open, not a second persistence layer.
export function ensureMetaSchema(d: DbLike): void {
  d.execSync('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
}

export function getMetaCore(d: DbLike, key: string): string | null {
  return d.getFirstSync<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}

export function setMetaCore(d: DbLike, key: string, value: string): void {
  d.runSync(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, value,
  );
}

export function insertJourneysCore(d: DbLike, journeys: ParsedJourney[], now: string): ImportSummary {
  const summary: ImportSummary = { inserted: 0, duplicates: 0, incomplete: 0, upgraded: 0 };
  d.withTransactionSync(() => {
    for (const j of journeys) {
      if (j.tapInTime) {
        // Upgrade path (TfL-8): a row imported by the pre-hotfix parser carries
        // null tap times; the re-imported statement has the same journey with
        // times. UPDATE in place so the row id — and any claim referencing it —
        // survives. The dedupe index allows at most one such row per
        // card+date+origin. OR IGNORE: if the timed row also already exists,
        // the update would collide with it and is skipped; the insert below
        // then counts the incoming row as a duplicate, and the stale broken
        // row is swept by migrateLegacyImportRows at next open.
        const up = d.runSync(
          `UPDATE OR IGNORE journeys
           SET tap_in_time = ?, tap_out_time = ?, destination = ?, charge = ?, incomplete = ?, raw_action = ?, imported_at = ?
           WHERE card = ? AND date = ? AND origin = ? AND IFNULL(destination, '') = IFNULL(?, '')
             AND tap_in_time IS NULL`,
          j.tapInTime, j.tapOutTime, j.destination, j.charge, j.incomplete ? 1 : 0, j.rawAction, now,
          j.card, j.date, j.origin, j.destination,
        );
        if (up.changes > 0) { summary.upgraded++; continue; }
      }
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
