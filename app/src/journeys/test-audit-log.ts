// Audit log tests (TfL-18) — run with:
//   node --experimental-strip-types src/journeys/test-audit-log.ts
import assert from 'node:assert/strict';
import {
  appendAudit,
  AUDIT_LOG_CAP,
  AUDIT_LOG_KEY,
  type AuditEntry,
  clearedAudit,
  formatAudit,
  formatAuditLine,
  parseAudit,
} from './audit-log.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const AT = '2026-07-12T21:03:07.123Z';

// --- parse tolerance: the log must never be able to break a refresh ---
ok(parseAudit(null).length === 0, 'missing log parses to empty');
ok(parseAudit('').length === 0, 'empty string parses to empty');
ok(parseAudit('not json{{{').length === 0, 'corrupt JSON parses to empty, never throws');
ok(parseAudit('{"a":1}').length === 0, 'non-array JSON parses to empty');
ok(parseAudit('[1,"x",null,{"at":1,"tag":"y"},{"tag":"no-at"}]').length === 0,
  'malformed entries are dropped');
{
  const mixed = parseAudit(`[{"at":"${AT}","tag":"nav","detail":"u"},"junk",{"at":"${AT}","tag":"phase"}]`);
  ok(mixed.length === 2 && mixed[0].tag === 'nav' && mixed[0].detail === 'u' && mixed[1].detail === undefined,
    'valid entries survive alongside junk; empty detail is dropped');
}

// --- append: ring buffer semantics, tolerant of corrupt existing JSON ---
{
  let json: string | null = null;
  json = appendAudit(json, { at: AT, tag: 'refresh-start', detail: 'mode contactless' });
  json = appendAudit(json, { at: AT, tag: 'nav', detail: 'https://x' });
  const log = parseAudit(json);
  ok(log.length === 2 && log[0].tag === 'refresh-start' && log[1].tag === 'nav',
    'append builds the log in order');
}
ok(parseAudit(appendAudit('garbage', { at: AT, tag: 't' })).length === 1,
  'append on corrupt JSON starts a fresh log');
{
  const noDetail = parseAudit(appendAudit(null, { at: AT, tag: 't', detail: '' }))[0];
  ok(noDetail.detail === undefined, 'empty detail is not persisted');
}
{
  let json: string | null = null;
  for (let i = 0; i < 10; i++) json = appendAudit(json, { at: AT, tag: `e${i}` }, 4);
  const log = parseAudit(json);
  ok(log.length === 4 && log[0].tag === 'e6' && log[3].tag === 'e9',
    'cap keeps only the newest entries');
}
ok(AUDIT_LOG_CAP >= 200, 'default cap holds several full refreshes');
ok(AUDIT_LOG_KEY === 'auditLog', 'meta key is stable');
ok(parseAudit(clearedAudit()).length === 0, 'clearedAudit persists an empty log');

// --- formatting: shareable plain text ---
{
  const line = formatAuditLine({ at: AT, tag: 'nav', detail: 'https://contactless.tfl.gov.uk/Dashboard' });
  ok(line === '12 Jul 21:03:07  nav  https://contactless.tfl.gov.uk/Dashboard',
    'line format: short time, tag, detail');
  ok(formatAuditLine({ at: AT, tag: 'phase' }) === '12 Jul 21:03:07  phase',
    'line format without detail has no trailing spaces');
  ok(formatAuditLine({ at: 'weird', tag: 't' }) === 'weird  t',
    'non-ISO timestamps pass through untouched');
}
{
  const entries: AuditEntry[] = [
    { at: AT, tag: 'refresh-start' },
    { at: AT, tag: 'nav', detail: 'https://x' },
  ];
  const text = formatAudit(entries);
  ok(text.split('\n').length === 2 && text.includes('refresh-start') && text.endsWith('https://x'),
    'formatAudit joins lines oldest-first');
  ok(formatAudit([]).includes('empty'), 'empty log formats to a friendly message');
}

console.log(`\ntest-audit-log: all ${passed} assertions passed.`);
