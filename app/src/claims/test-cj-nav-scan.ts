// CorrectableJourneys nav-scan tests — run with:
//   node --experimental-strip-types src/claims/test-cj-nav-scan.ts
import assert from 'node:assert/strict';
import { buildCjNavScanScript, dateToLabel } from './cj-nav-scan.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// ── dateToLabel ───────────────────────────────────────────────────────────────

ok(dateToLabel('2026-07-15') === '15 Jul', 'dateToLabel: 2026-07-15 → "15 Jul"');
ok(dateToLabel('2026-03-03') === '3 Mar',  'dateToLabel: 2026-03-03 → "3 Mar" (no zero-pad)');
ok(dateToLabel('2026-01-01') === '1 Jan',  'dateToLabel: 2026-01-01 → "1 Jan"');
ok(dateToLabel('2026-12-31') === '31 Dec', 'dateToLabel: 2026-12-31 → "31 Dec"');

// ── Scanner: stub helpers ─────────────────────────────────────────────────────

type Msg = { type: string; status?: string; href?: string; found?: number; matched?: number };

function mkAnchor(href: string, rowText: string) {
  const row: any = {
    tagName: 'LI',
    textContent: rowText,
    getAttribute: (_: string) => null,
    parentElement: { tagName: 'UL', textContent: '', getAttribute: (_: string) => null, parentElement: null, parentNode: null },
    parentNode: null,
  };
  const anchor: any = {
    tagName: 'A',
    getAttribute: (a: string) => a === 'href' ? href : null,
    parentElement: row,
    parentNode: row,
  };
  return anchor;
}

function runScan(plan: { date: string; origin: string }, anchors: any[]): Msg[] {
  const posted: Msg[] = [];
  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    location: { protocol: 'https:', host: 'contactless.tfl.gov.uk', href: '' },
  };
  const doc = {
    querySelectorAll: (sel: string) => sel === 'a[href]' ? anchors : [],
  };
  new Function('window', 'document', buildCjNavScanScript(plan))(win, doc);
  return posted;
}

// ── Scanner behaviour ─────────────────────────────────────────────────────────

// Single confident match — scanner navigates
{
  const a = mkAnchor('/Refunds/ApplyForRefund?journeyId=42', '15 Jul 2026 Wimbledon to London Bridge');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [a]);
  ok(msgs.length === 1 && msgs[0].status === 'navigating', 'single match: status=navigating');
  ok((msgs[0].href ?? '').includes('/ApplyForRefund?journeyId=42'),
    'single match: href contains the ApplyForRefund path');
  ok((msgs[0].href ?? '').startsWith('https://contactless.tfl.gov.uk'),
    'single match: relative href resolved to absolute URL');
}

// No match — date wrong
{
  const a = mkAnchor('/Refunds/ApplyForRefund?journeyId=99', '14 Jul 2026 Wimbledon to Victoria');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [a]);
  ok(msgs.length === 1 && msgs[0].status === 'no-match',
    'no-match: row date 14 Jul does not match target 15 Jul');
}

// No match — origin wrong
{
  const a = mkAnchor('/Refunds/ApplyForRefund?journeyId=5', '15 Jul 2026 Southfields to Victoria');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [a]);
  ok(msgs.length === 1 && msgs[0].status === 'no-match',
    'no-match: row origin Southfields does not match target Wimbledon');
}

// No links at all
{
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, []);
  ok(msgs.length === 1 && msgs[0].status === 'no-links', 'no-links: no ApplyForRefund anchors on page');
}

// Ambiguous — two rows both match date + origin
{
  const a1 = mkAnchor('/Refunds/ApplyForRefund?journeyId=1', '15 Jul 2026 Wimbledon to London Bridge');
  const a2 = mkAnchor('/Refunds/ApplyForRefund?journeyId=2', '15 Jul 2026 Wimbledon to Bank');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [a1, a2]);
  ok(msgs.length === 1 && msgs[0].status === 'ambiguous' && msgs[0].matched === 2,
    'ambiguous: two rows match → status=ambiguous, matched=2');
}

// Leading-zero day in row text still matches (TfL may display "03 Mar")
{
  const a = mkAnchor('/Refunds/ApplyForRefund?journeyId=7', '03 Mar 2026 Finchley Central to King Cross');
  const msgs = runScan({ date: '2026-03-03', origin: 'Finchley Central' }, [a]);
  ok(msgs.length === 1 && msgs[0].status === 'navigating',
    'date: "3 mar" is a substring of "03 mar" — matches correctly');
}

// Non-ApplyForRefund link is ignored
{
  const other = mkAnchor('/Refunds/SomeOtherPage', '15 Jul 2026 Wimbledon to London Bridge');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [other]);
  ok(msgs.length === 1 && msgs[0].status === 'no-links',
    'non-ApplyForRefund href ignored; no-links reported');
}

// Case-insensitive matching for origin
{
  const a = mkAnchor('/Refunds/ApplyForRefund?journeyId=33', '15 Jul 2026 WIMBLEDON to Waterloo');
  const msgs = runScan({ date: '2026-07-15', origin: 'Wimbledon' }, [a]);
  ok(msgs.length === 1 && msgs[0].status === 'navigating',
    'case-insensitive: origin "WIMBLEDON" matches plan "Wimbledon"');
}

console.log(`\ntest-cj-nav-scan: all ${passed} assertions passed`);
