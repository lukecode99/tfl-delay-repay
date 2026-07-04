// SQLite adapters for the eligibility engine's injected interfaces.
// The timing cache lives in the app's own DB; the disruption lookup reads a
// synced copy of the TfL-1 collector ledger (same status_log schema).
import * as SQLite from 'expo-sqlite';
import type { DisruptionLookup, LedgerEvidence } from './engine';
import type { PairTiming, TimingCache } from './planner';

/** Persistent per-station-pair timing cache backed by the given DB. */
export function makeSqliteTimingCache(db: SQLite.SQLiteDatabase, maxAgeDays = 90): TimingCache {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS timing_cache (
      pair TEXT PRIMARY KEY,
      timing TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  const cutoff = () => new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  return {
    get(key) {
      const row = db.getFirstSync<{ timing: string }>(
        'SELECT timing FROM timing_cache WHERE pair = ? AND fetched_at > ?', key, cutoff(),
      );
      return row ? (JSON.parse(row.timing) as PairTiming) : null;
    },
    set(key, value) {
      db.runSync(
        'INSERT OR REPLACE INTO timing_cache (pair, timing, fetched_at) VALUES (?, ?, ?)',
        key, JSON.stringify(value), value.fetchedAt,
      );
    },
  };
}

/**
 * DisruptionLookup over a local copy of the collector's status_log table
 * (TfL-1 schema: ts, line, status_severity, status_description, reason).
 */
export function makeSqliteLookup(db: SQLite.SQLiteDatabase): DisruptionLookup {
  return (lines, fromISO, toISO): LedgerEvidence => {
    if (!lines.length) return { coverage: 0, statuses: [] };
    const marks = lines.map(() => '?').join(',');
    const coverage = db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM status_log WHERE line IN (${marks}) AND ts >= ? AND ts <= ?`,
      ...lines, fromISO, toISO,
    )?.n ?? 0;
    const rows = db.getAllSync<any>(
      `SELECT ts, line, status_severity, status_description, reason
       FROM status_log
       WHERE line IN (${marks}) AND ts >= ? AND ts <= ? AND status_severity != 10
       ORDER BY status_severity ASC, ts ASC`,
      ...lines, fromISO, toISO,
    );
    return {
      coverage,
      statuses: rows.map(r => ({
        ts: r.ts,
        line: r.line,
        statusSeverity: r.status_severity,
        statusDescription: r.status_description,
        reason: r.reason,
      })),
    };
  };
}
