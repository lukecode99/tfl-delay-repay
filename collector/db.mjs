// SQLite layer for the TfL disruption ledger (TfL-1).
// Uses node:sqlite (Node 22 built-in) — zero npm dependencies, so the VM
// install is just "node + these files".
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DB lives next to this file's project root regardless of cwd; override with TFL_DB_PATH.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DB_PATH = process.env.TFL_DB_PATH || path.join(PROJECT_ROOT, 'disruptions.db');

export function openDb(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- One row per line per poll, INCLUDING Good Service rows. Recording the
    -- healthy polls too is deliberate: it lets the eligibility engine (TfL-4)
    -- distinguish "the line was fine" from "the collector wasn't running",
    -- which matters when a claim hinges on evidence of disruption.
    CREATE TABLE IF NOT EXISTS status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,                 -- ISO 8601 UTC, time of poll
      line TEXT NOT NULL,               -- TfL line id, e.g. 'victoria', 'elizabeth', 'windrush'
      line_name TEXT NOT NULL,          -- display name, e.g. 'Victoria'
      mode TEXT NOT NULL,               -- tube | dlr | overground | elizabeth-line
      status_severity INTEGER NOT NULL, -- TfL scale; 10 = Good Service, lower = worse
      status_description TEXT NOT NULL, -- e.g. 'Minor Delays'
      reason TEXT                       -- disruption reason text, NULL for Good Service
    );
    CREATE INDEX IF NOT EXISTS idx_status_line_ts ON status_log (line, ts);
    CREATE INDEX IF NOT EXISTS idx_status_ts ON status_log (ts);

    -- One row per successful poll cycle — coverage record.
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      lines_reported INTEGER NOT NULL,
      disrupted_count INTEGER NOT NULL
    );
  `);
  return db;
}

// Insert one poll's worth of statuses atomically.
export function recordPoll(db, ts, rows) {
  const insert = db.prepare(
    'INSERT INTO status_log (ts, line, line_name, mode, status_severity, status_description, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const disrupted = rows.filter(r => r.statusSeverity !== 10).length;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      insert.run(ts, r.line, r.lineName, r.mode, r.statusSeverity, r.statusDescription, r.reason ?? null);
    }
    db.prepare('INSERT INTO polls (ts, lines_reported, disrupted_count) VALUES (?, ?, ?)')
      .run(ts, rows.length, disrupted);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { lines: rows.length, disrupted };
}

// wasDisrupted(line, fromISO, toISO) — the query helper required by TfL-1.
// Returns { disrupted, coverage, statuses } where:
//   disrupted — true if any poll in the window logged severity != 10 for the line
//   coverage  — number of polls of that line inside the window (0 = no evidence either way)
//   statuses  — the disrupted rows (ts, severity, description, reason), worst first
// `line` accepts a line id ('victoria') or display name ('Victoria'), case-insensitive.
export function wasDisrupted(db, line, fromISO, toISO) {
  const needle = String(line).toLowerCase();
  const coverage = db.prepare(
    'SELECT COUNT(*) AS n FROM status_log WHERE (line = ? OR lower(line_name) = ?) AND ts >= ? AND ts <= ?'
  ).get(needle, needle, fromISO, toISO).n;
  const statuses = db.prepare(
    `SELECT ts, status_severity AS statusSeverity, status_description AS statusDescription, reason
     FROM status_log
     WHERE (line = ? OR lower(line_name) = ?) AND ts >= ? AND ts <= ? AND status_severity != 10
     ORDER BY status_severity ASC, ts ASC`
  ).all(needle, needle, fromISO, toISO);
  return { disrupted: statuses.length > 0, coverage, statuses };
}
