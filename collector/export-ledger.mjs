#!/usr/bin/env node
// Export the collector ledger to a compact JSON snapshot the app bundles
// (app/src/data/ledger.json). Run before committing app changes so each
// TestFlight build ships the freshest evidence.
//
//   node export-ledger.mjs [--db path] [--out path] [--days N]
//
// Compaction, so the snapshot stays small as the ledger grows:
//  - poll timestamps merge into coverage ranges (gap <= 15 min = same range)
//  - consecutive identical statuses per line collapse into disruption spans
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = flag('db', path.join(here, '..', 'disruptions.db'));
const outPath = flag('out', path.join(here, '..', 'app', 'src', 'data', 'ledger.json'));
const days = Number(flag('days', '120')); // claim window is 28 days; keep a buffer
const sinceISO = new Date(Date.now() - days * 86400_000).toISOString();

const MERGE_GAP_MS = 15 * 60_000; // collector polls every 5 min; 15 covers hiccups

const db = new DatabaseSync(dbPath, { readOnly: true });

// Coverage ranges from poll timestamps.
const polls = db.prepare('SELECT ts FROM polls WHERE ts >= ? ORDER BY ts').all(sinceISO);
const coverage = [];
for (const { ts } of polls) {
  const last = coverage[coverage.length - 1];
  if (last && Date.parse(ts) - Date.parse(last.to) <= MERGE_GAP_MS) {
    last.to = ts;
    last.polls++;
  } else {
    coverage.push({ from: ts, to: ts, polls: 1 });
  }
}

// Disruption spans: collapse consecutive identical (line, severity, desc, reason).
const rows = db.prepare(
  `SELECT ts, line, line_name, status_severity, status_description, reason
   FROM status_log WHERE ts >= ? AND status_severity != 10 ORDER BY line, ts`,
).all(sinceISO);
const spans = [];
let cur = null;
for (const r of rows) {
  const same = cur && cur.line === r.line && cur.severity === r.status_severity &&
    cur.description === r.status_description && (cur.reason ?? null) === (r.reason ?? null) &&
    Date.parse(r.ts) - Date.parse(cur.to) <= MERGE_GAP_MS;
  if (same) {
    cur.to = r.ts;
  } else {
    cur = {
      line: r.line, lineName: r.line_name, from: r.ts, to: r.ts,
      severity: r.status_severity, description: r.status_description, reason: r.reason ?? null,
    };
    spans.push(cur);
  }
}
spans.sort((a, b) => a.from.localeCompare(b.from));

const snapshot = { generatedAt: new Date().toISOString(), sinceISO, coverage, spans };
writeFileSync(outPath, JSON.stringify(snapshot, null, 1) + '\n');
console.log(
  `ledger.json: ${polls.length} polls -> ${coverage.length} coverage ranges, ` +
  `${rows.length} disrupted rows -> ${spans.length} spans (${outPath})`,
);
