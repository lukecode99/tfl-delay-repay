// TfL disruption collector (TfL-1) — one-shot poll, run every 5 min by a timer.
//
// Fetches line status for tube + DLR + Overground + Elizabeth line and appends
// every line's status (including Good Service — see db.mjs for why) to disruptions.db.
// TfL has no historical delay API, so this ledger is the app's only source of
// delay evidence: it only accrues from the day it runs.
//
// TFL_APP_KEY is optional — anonymous access is rate-limited but one request
// per 5 minutes is far inside it. Set the key once registered to be polite.
//
// Exit codes: 0 = poll recorded, 1 = fetch/parse/db failure (timer just retries next tick).

import https from 'node:https';
import { openDb, recordPoll, DB_PATH } from './db.mjs';

const MODES = 'tube,dlr,overground,elizabeth-line';
const APP_KEY = process.env.TFL_APP_KEY || '';

function fetchStatus() {
  const path = `/Line/Mode/${MODES}/Status?detail=true${APP_KEY ? `&app_key=${APP_KEY}` : ''}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.tfl.gov.uk',
      path,
      method: 'GET',
      agent: new https.Agent({}), // bypass env proxy — direct call
      headers: { 'Accept': 'application/json', 'User-Agent': 'tfl-delay-repay-collector/1.0' },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`TfL API ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`TfL API bad JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TfL API timeout (30s)')));
    req.on('error', reject);
    req.end();
  });
}

// Flatten the API response: one row per line per status entry.
// A line can carry several simultaneous statuses (e.g. Part Closure + Minor Delays).
export function flattenStatuses(lines) {
  const rows = [];
  for (const l of lines) {
    for (const s of l.lineStatuses || []) {
      rows.push({
        line: l.id,
        lineName: l.name,
        mode: l.modeName,
        statusSeverity: s.statusSeverity,
        statusDescription: s.statusSeverityDescription,
        reason: s.reason || null,
      });
    }
  }
  return rows;
}

async function main() {
  const ts = new Date().toISOString();
  const lines = await fetchStatus();
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('TfL API returned no lines');
  const rows = flattenStatuses(lines);
  const db = openDb();
  try {
    const { lines: n, disrupted } = recordPoll(db, ts, rows);
    console.log(`[${ts}] recorded ${rows.length} statuses across ${lines.length} lines (${disrupted} disrupted) → ${DB_PATH}`);
  } finally {
    db.close();
  }
}

// Only run when invoked directly (so tests can import flattenStatuses).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch(e => { console.error(`[collector] FAILED: ${e.message}`); process.exit(1); });
}
