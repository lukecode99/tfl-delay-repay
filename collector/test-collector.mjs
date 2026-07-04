// Unit tests for the disruption collector (TfL-1) — fixture payload, in-memory DB.
import assert from 'node:assert';
import { openDb, recordPoll, wasDisrupted } from './db.mjs';
import { flattenStatuses } from './collector.mjs';

// ── flattenStatuses ────────────────────────────────────────────────
const fixture = [
  { id: 'victoria', name: 'Victoria', modeName: 'tube', lineStatuses: [
    { statusSeverity: 6, statusSeverityDescription: 'Severe Delays', reason: 'Victoria Line: Severe delays due to a signal failure at Brixton.' },
  ]},
  { id: 'central', name: 'Central', modeName: 'tube', lineStatuses: [
    { statusSeverity: 10, statusSeverityDescription: 'Good Service' },
  ]},
  // A line can report two simultaneous statuses
  { id: 'windrush', name: 'Windrush', modeName: 'overground', lineStatuses: [
    { statusSeverity: 3, statusSeverityDescription: 'Part Closure', reason: 'No service between Sydenham and Crystal Palace.' },
    { statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'Minor delays on the rest of the line.' },
  ]},
];
const rows = flattenStatuses(fixture);
assert.equal(rows.length, 4, 'one row per status entry, not per line');
assert.equal(rows[0].line, 'victoria');
assert.equal(rows[0].statusSeverity, 6);
assert.equal(rows[1].reason, null, 'Good Service carries null reason');
assert.equal(rows.filter(r => r.line === 'windrush').length, 2, 'multi-status line keeps both rows');

// ── recordPoll + wasDisrupted ──────────────────────────────────────
const db = openDb(':memory:');
recordPoll(db, '2026-07-04T08:00:00.000Z', rows);
recordPoll(db, '2026-07-04T08:05:00.000Z', rows.map(r => ({ ...r, statusSeverity: 10, statusDescription: 'Good Service', reason: null })));

// Disrupted line inside window
const vic = wasDisrupted(db, 'victoria', '2026-07-04T07:00:00Z', '2026-07-04T09:00:00Z');
assert.equal(vic.disrupted, true, 'victoria disrupted');
assert.equal(vic.coverage, 2, 'two polls covered victoria');
assert.equal(vic.statuses.length, 1, 'only the severity!=10 row returned');
assert.match(vic.statuses[0].reason, /signal failure/, 'reason preserved');

// Display-name and case-insensitive lookup
assert.equal(wasDisrupted(db, 'Victoria', '2026-07-04T07:00:00Z', '2026-07-04T09:00:00Z').disrupted, true, 'display name works');

// Clean line: not disrupted but covered (evidence of good service)
const cen = wasDisrupted(db, 'central', '2026-07-04T07:00:00Z', '2026-07-04T09:00:00Z');
assert.equal(cen.disrupted, false, 'central clean');
assert.equal(cen.coverage, 2, 'clean line still has coverage');

// No data: distinguish "collector wasn't running" from "line was fine"
const early = wasDisrupted(db, 'victoria', '2026-07-01T00:00:00Z', '2026-07-01T23:59:59Z');
assert.equal(early.disrupted, false);
assert.equal(early.coverage, 0, 'zero coverage outside collection window');

// Window boundaries are inclusive
assert.equal(wasDisrupted(db, 'victoria', '2026-07-04T08:00:00.000Z', '2026-07-04T08:00:00.000Z').coverage, 1, 'inclusive bounds');

// Multi-status line: worst severity first
const win = wasDisrupted(db, 'windrush', '2026-07-04T07:00:00Z', '2026-07-04T09:00:00Z');
assert.equal(win.statuses.length, 2);
assert.equal(win.statuses[0].statusSeverity, 3, 'worst status first');

// Poll coverage table
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 2, 'one polls row per cycle');
assert.equal(db.prepare('SELECT disrupted_count FROM polls ORDER BY id').all()[0].disrupted_count, 3, 'disrupted count recorded');

db.close();
console.log('collector tests passed (16 assertions)');
