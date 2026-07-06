// Auto-fetch tests (TfL-10) — run with:
//   node --experimental-strip-types src/journeys/test-autofetch.ts
// The harvest script tests execute the exact injected string against a stub
// DOM (Hermes can't serialise functions, so the script ships as text and this
// is the only way to test what actually runs in the WebView).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  AUTOFETCH_RATE_LIMIT_ENABLED,
  buildHarvestScript,
  isNewFetchDay,
  JOURNEY_HISTORY_URL,
  pickCardId,
  rowsToCsv,
  shouldAutoFetch,
} from './autofetch.ts';
import { csvRows, parseStatement } from './parse.ts';
import {
  type DbLike,
  ensureJourneySchema,
  ensureMetaSchema,
  getMetaCore,
  insertJourneysCore,
  setMetaCore,
} from './store-core.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- rate limit: day logic (limit itself currently switched off for testing) ---
ok(isNewFetchDay(null, '2026-07-06T08:00:00.000Z'), 'day logic: first ever fetch is a new day');
ok(!isNewFetchDay('2026-07-06T07:00:00.000Z', '2026-07-06T22:00:00.000Z'),
  'day logic: same UTC day is not a new day');
ok(isNewFetchDay('2026-07-05T23:59:00.000Z', '2026-07-06T00:01:00.000Z'),
  'day logic: next day is a new day');
ok(AUTOFETCH_RATE_LIMIT_ENABLED === false, 'rate limit: currently disabled for on-device testing');
ok(shouldAutoFetch('2026-07-06T07:00:00.000Z', '2026-07-06T22:00:00.000Z'),
  'rate limit: same-day refetch allowed while the limit is off');

// --- card id: dedupe against previous imports whatever the CSV was called ---
ok(pickCardId([]) === 'contactless', 'card id: fallback when nothing imported yet');
ok(pickCardId(['1688', '1688', '1688']) === '1688', 'card id: reuses the existing card');
ok(pickCardId(['old', '1688', '1688']) === '1688', 'card id: most frequent card wins');
ok(pickCardId(['unknown', '', 'unknown']) === 'contactless', 'card id: unknown/blank never reused');

// --- scraped rows → CSV → existing parser ---
{
  const csv = rowsToCsv([['a', 'b,c', 'd"e'], ['f', '', 'g']]);
  const back = csvRows(csv);
  ok(back.length === 2 && back[0][1] === 'b,c' && back[0][2] === 'd"e' && back[1][1] === '',
    'rowsToCsv: commas and quotes survive the round trip');
}
{
  // The journey table as the history page shows it (combined Time column,
  // negative charges) — must come out of the normal parser intact.
  const rows = [
    ['Date', 'Time', 'Journey / Action', 'Charge'],
    ['04/07/2026', '10:32 - 11:18', 'Eastcote to Sudbury Town', '-£2.20'],
    ['04/07/2026', '17:24', 'Bus journey, route 487', '-£1.75'],
  ];
  const parsed = parseStatement(rowsToCsv(rows), '1688');
  ok(parsed.journeys.length === 1 && parsed.skipped === 1, 'scrape: rail journey parsed, bus row skipped');
  const j = parsed.journeys[0];
  ok(j.date === '2026-07-04' && j.tapInTime === '10:32' && j.tapOutTime === '11:18'
    && j.origin === 'Eastcote' && j.destination === 'Sudbury Town' && j.charge === 2.2 && j.card === '1688',
    'scrape: date, combined time column, stations, charge sign and card all correct');
}

// --- harvest script: shape ---
{
  const script = buildHarvestScript();
  new Function(script);
  ok(true, 'script: syntactically valid JavaScript');
  ok(script.trimEnd().endsWith('true;'), 'script: ends with true for injectJavaScript');
  ok(script.includes('postMessage'), 'script: reports back through postMessage');
  ok(JOURNEY_HISTORY_URL.startsWith('https://contactless.tfl.gov.uk/'), 'history URL is the contactless account site');
}

// --- harvest script: behaviour against a stub DOM ---
interface StubAnchor { href: string; text?: string }
function harvestDoc(over: { password?: boolean; anchors?: StubAnchor[]; tables?: string[][][] } = {}) {
  return {
    querySelector: (sel: string) => (sel === 'input[type="password"]' && over.password ? {} : null),
    querySelectorAll: (sel: string) => {
      if (sel === 'a[href]') {
        return (over.anchors ?? []).map(a => ({
          href: a.href,
          textContent: a.text ?? '',
          getAttribute: (n: string) => (n === 'href' ? a.href : null),
        }));
      }
      if (sel === 'table') {
        return (over.tables ?? []).map(rows => ({
          querySelectorAll: (s: string) => (s === 'tr'
            ? rows.map(cells => ({ querySelectorAll: (s2: string) => (s2 === 'th, td' ? cells.map(c => ({ textContent: c })) : []) }))
            : []),
        }));
      }
      return [];
    },
  };
}
async function runHarvest(doc: any, winOver: { href?: string; fetch?: any } = {}) {
  const messages: any[] = [];
  const win: any = {
    location: { href: winOver.href ?? JOURNEY_HISTORY_URL },
    fetch: winOver.fetch,
    ReactNativeWebView: { postMessage: (s: string) => messages.push(JSON.parse(s)) },
  };
  new Function('document', 'window', buildHarvestScript())(doc, win);
  await new Promise(r => setTimeout(r, 10)); // let the fetch promise chain settle
  return messages;
}

{
  const msgs = await runHarvest(harvestDoc({ password: true }));
  ok(msgs.length === 1 && msgs[0].status === 'signed-out',
    'harvest: password field on the page → signed-out, nothing else attempted');
}
{
  const msgs = await runHarvest(harvestDoc(), { href: 'https://account.tfl.gov.uk/Login?returnUrl=x' });
  ok(msgs.length === 1 && msgs[0].status === 'signed-out', 'harvest: redirect to the sign-in URL → signed-out');
}
{
  const calls: any[] = [];
  const fetchStub = (url: string, opts: any) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, text: () => Promise.resolve('Date,Journey\ncsv-data') });
  };
  const msgs = await runHarvest(
    harvestDoc({ anchors: [{ href: '/help', text: 'Help' }, { href: '/Statements/Export?format=csv', text: 'Download CSV' }] }),
    { fetch: fetchStub },
  );
  ok(calls.length === 1 && String(calls[0].url).includes('csv') && calls[0].opts.credentials === 'include',
    'harvest: CSV export link fetched with the session cookie (credentials: include)');
  ok(msgs.length === 1 && msgs[0].status === 'csv' && msgs[0].text === 'Date,Journey\ncsv-data',
    'harvest: CSV text posted back to the app');
}
{
  const table = [
    ['Date', 'Time', 'Journey / Action', 'Charge'],
    ['04/07/2026', '10:32  -  11:18', 'Eastcote  to  Sudbury Town', '-£2.20'],
  ];
  const fetch401 = () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('') });
  const msgs = await runHarvest(
    harvestDoc({
      anchors: [{ href: '/Statements/Export?format=csv', text: 'Download CSV' }],
      tables: [[['Menu', 'Links'], ['Home', 'Help']], table],
    }),
    { fetch: fetch401 },
  );
  ok(msgs.length === 1 && msgs[0].status === 'rows', 'harvest: failed CSV fetch falls back to scraping the table');
  ok(msgs[0].rows.length === 2 && msgs[0].rows[0][0] === 'Date' && msgs[0].rows[1][2] === 'Eastcote to Sudbury Town',
    'harvest: journey table picked over other tables, whitespace collapsed');
}
{
  const msgs = await runHarvest(harvestDoc({ tables: [[['Menu'], ['Home']]] }));
  ok(msgs.length === 1 && msgs[0].status === 'empty', 'harvest: page with no journey table → empty, not a crash');
}
{
  const hostile = { querySelector: () => null, querySelectorAll: () => { throw new Error('boom'); } };
  const msgs = await runHarvest(hostile);
  ok(msgs.length === 1 && msgs[0].status === 'error' && String(msgs[0].message).includes('boom'),
    'harvest: hostile DOM reports an error instead of throwing into the page');
}

// --- SC(4): auto-fetched rows dedupe against previously imported ones ---
function makeDb(): DbLike {
  const raw = new DatabaseSync(':memory:');
  return {
    execSync: (sql: string) => { raw.exec(sql); },
    runSync: (sql: string, ...params: any[]) => ({ changes: Number(raw.prepare(sql).run(...params).changes) }),
    getAllSync: <T,>(sql: string, ...params: any[]) => raw.prepare(sql).all(...params) as T[],
    getFirstSync: <T,>(sql: string, ...params: any[]) => (raw.prepare(sql).get(...params) as T) ?? null,
    withTransactionSync: (fn: () => void) => {
      raw.exec('BEGIN');
      try { fn(); raw.exec('COMMIT'); }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}
{
  const d = makeDb();
  ensureJourneySchema(d);
  const rows = [
    ['Date', 'Time', 'Journey / Action', 'Charge'],
    ['04/07/2026', '10:32 - 11:18', 'Eastcote to Sudbury Town', '-£2.20'],
    ['05/07/2026', '09:01 - 09:24', 'Eastcote to Bank', '-£3.40'],
  ];
  const parsed = parseStatement(rowsToCsv(rows), '1688');
  const first = insertJourneysCore(d, parsed.journeys, '2026-07-06T08:00:00Z');
  ok(first.inserted === 2 && first.duplicates === 0, 'dedupe: first auto-fetch inserts everything');
  const again = insertJourneysCore(d, parseStatement(rowsToCsv(rows), '1688').journeys, '2026-07-06T09:00:00Z');
  ok(again.inserted === 0 && again.duplicates === 2, 'dedupe: same journeys fetched again → all duplicates, nothing doubled');
  const third = insertJourneysCore(d, parseStatement(rowsToCsv([
    rows[0], rows[1],
    ['06/07/2026', '19:59 - 20:31', 'Eastcote to Rayners Lane', '-£2.20'],
  ]), '1688').journeys, '2026-07-07T08:00:00Z');
  ok(third.inserted === 1 && third.duplicates === 1, 'dedupe: overlapping fetch inserts only the new journey');
}

// --- meta store (last-fetch stamp persistence) ---
{
  const d = makeDb();
  ensureMetaSchema(d);
  ok(getMetaCore(d, 'lastAutoFetch') === null, 'meta: missing key reads as null');
  setMetaCore(d, 'lastAutoFetch', '2026-07-06T08:00:00Z');
  ok(getMetaCore(d, 'lastAutoFetch') === '2026-07-06T08:00:00Z', 'meta: value round-trips');
  setMetaCore(d, 'lastAutoFetch', '2026-07-07T08:00:00Z');
  ok(getMetaCore(d, 'lastAutoFetch') === '2026-07-07T08:00:00Z', 'meta: upsert overwrites in place');
}

console.log(`\ntest-autofetch: all ${passed} assertions passed.`);
