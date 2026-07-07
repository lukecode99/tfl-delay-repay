// Direct CSV fetch tests (TfL-14) — run with:
//   node --experimental-strip-types src/journeys/test-direct-csv.ts
// The script tests execute the exact injected string against a stub DOM, same
// as test-autofetch.ts — the string is what actually runs in the WebView.
// Card ids in here are deliberately fake (aaa…/bbb…): never a real one.
import assert from 'node:assert/strict';
import {
  buildCsvUrl,
  buildDirectCsvScript,
  currentAndPreviousPeriods,
  extractCardDisplayId,
  isNewStatementsUrl,
  looksLikeCsv,
  MAX_DIRECT_CARDS,
  NEW_STATEMENTS_URL,
} from './direct-csv.ts';
import {
  CONTACTLESS_HISTORY_URL,
  type FlowEvent,
  type FlowState,
  makeInitialFlow,
  MAX_STEERS,
  NEW_STATEMENTS_URL as FLOW_NEW_STATEMENTS_URL,
  OYSTER_HISTORY_URL,
  reduceFlow,
  startUrlFor,
} from './refresh-flow.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const CARD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CARD_C = 'cccccccccccccccccccccccccccccccc';
const CSV_BODY = 'Date,Start Time,End Time,Journey,Charge\n04/07/2026,10:32,11:18,Eastcote to Sudbury Town,2.20';

// --- constants stay in lockstep across the zero-import modules ---
ok(NEW_STATEMENTS_URL === FLOW_NEW_STATEMENTS_URL,
  'constants: direct-csv and refresh-flow agree on the statements URL');
ok(isNewStatementsUrl('https://contactless.tfl.gov.uk/NewStatements')
  && isNewStatementsUrl('https://contactless.tfl.gov.uk/newstatements?x=1')
  && !isNewStatementsUrl(CONTACTLESS_HISTORY_URL),
  'constants: statements URL recognised case-insensitively, history page is not');

// --- periods: <month>|<year>, current + previous, unpadded month ---
ok(currentAndPreviousPeriods('2026-07-07T10:00:00.000Z').join(',') === '7|2026,6|2026',
  'periods: July → 7|2026 then 6|2026 (month unpadded, matching the captured link)');
ok(currentAndPreviousPeriods('2027-01-05').join(',') === '1|2027,12|2026',
  'periods: January rolls the previous month into the prior year');
ok(currentAndPreviousPeriods('2026-12-31').join(',') === '12|2026,11|2026',
  'periods: December stays inside the year');
ok(currentAndPreviousPeriods('2026-05').join(',') === '5|2026,4|2026',
  'periods: a bare YYYY-MM prefix (local-time caller) works');

// --- URL construction: the captured endpoint's exact shape ---
ok(buildCsvUrl('5|2026', CARD_A)
  === `https://contactless.tfl.gov.uk/NewStatements/DownloadBillingCsv?Period=5%7C2026&CardDisplayId=${CARD_A}`,
  'url: Period pipe encodes to %7C, CardDisplayId appended — matches the device capture');

// --- card id extraction ---
ok(extractCardDisplayId(`/NewStatements/DownloadBillingCsv?Period=5%7C2026&CardDisplayId=${CARD_A}`) === CARD_A,
  'card id: pulled from a relative statement href');
ok(extractCardDisplayId(`https://contactless.tfl.gov.uk/NewStatements?CardDisplayId=${CARD_B.toUpperCase()}`) === CARD_B.toUpperCase(),
  'card id: uppercase hex accepted');
ok(extractCardDisplayId('/NewStatements?CardDisplayId=abc123') === null
  && extractCardDisplayId('/help') === null,
  'card id: short or missing ids rejected');

// --- CSV-vs-HTML guard ---
ok(looksLikeCsv(CSV_BODY), 'guard: a statement header row passes');
ok(looksLikeCsv('\uFEFF' + CSV_BODY), 'guard: BOM-prefixed CSV passes');
ok(looksLikeCsv('  \n' + CSV_BODY), 'guard: leading whitespace tolerated');
ok(!looksLikeCsv('<!DOCTYPE html><html>…'), 'guard: an HTML 200 is rejected');
ok(!looksLikeCsv(''), 'guard: empty response rejected');
ok(!looksLikeCsv('just some text without commas'), 'guard: comma-less body rejected');
ok(!looksLikeCsv('a,b,c\n1,2,3'), 'guard: header without a Date column rejected');

// --- script: shape ---
{
  const script = buildDirectCsvScript(['7|2026', '6|2026']);
  new Function(script);
  ok(true, 'script: syntactically valid JavaScript');
  ok(script.trimEnd().endsWith('true;'), 'script: ends with true for injectJavaScript');
  ok(script.includes('postMessage'), 'script: reports back through postMessage');
  ok(script.includes('["7|2026","6|2026"]'), 'script: the periods to fetch are embedded');
}

// --- script: behaviour against a stub DOM ---
interface StubAnchor { href: string }
function statementsDoc(over: {
  password?: boolean; challenge?: boolean; title?: string;
  anchors?: StubAnchor[]; options?: string[];
} = {}) {
  return {
    title: over.title ?? '',
    querySelector: (sel: string) => {
      if (sel === 'input[type="password"]') return over.password ? {} : null;
      if (sel.includes('challenge')) return over.challenge ? {} : null;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === 'a[href]') {
        return (over.anchors ?? []).map(a => ({
          href: a.href,
          getAttribute: (n: string) => (n === 'href' ? a.href : null),
        }));
      }
      if (sel === 'option') return (over.options ?? []).map(v => ({ value: v }));
      return [];
    },
  };
}
async function runDirect(
  doc: any,
  winOver: { href?: string; fetch?: any } = {},
  periods = ['7|2026', '6|2026'],
) {
  const messages: any[] = [];
  const win: any = {
    location: { href: winOver.href ?? NEW_STATEMENTS_URL },
    fetch: winOver.fetch,
    ReactNativeWebView: { postMessage: (s: string) => messages.push(JSON.parse(s)) },
  };
  new Function('document', 'window', buildDirectCsvScript(periods))(doc, win);
  await new Promise(r => setTimeout(r, 20)); // let the fetch chain settle
  return messages;
}

{
  const msgs = await runDirect(statementsDoc({ title: 'Just a moment…' }));
  ok(msgs.length === 1 && msgs[0].status === 'challenge', 'script: robot-check title → challenge, nothing fetched');
}
{
  const msgs = await runDirect(statementsDoc({ password: true }));
  ok(msgs.length === 1 && msgs[0].status === 'signed-out', 'script: password field → signed-out, nothing fetched');
}
{
  const msgs = await runDirect(statementsDoc(), { href: 'https://account.tfl.gov.uk/Login?returnUrl=x' });
  ok(msgs.length === 1 && msgs[0].status === 'signed-out', 'script: sign-in URL → signed-out');
}
{
  const msgs = await runDirect(statementsDoc(), { href: 'https://account.tfl.gov.uk/Dashboard' });
  ok(msgs.length === 1 && msgs[0].status === 'wrong-page', 'script: off the statements page → wrong-page, no guessing');
}
{
  // Happy path: two cards from links (one duplicated), a third from a card
  // <select>, non-card links ignored — every card × period fetched with the
  // session cookie, all six statements in one report.
  const calls: { url: string; opts: any }[] = [];
  const fetchStub = (url: string, opts: any) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, text: () => Promise.resolve(CSV_BODY) });
  };
  const msgs = await runDirect(statementsDoc({
    anchors: [
      { href: `/NewStatements/DownloadBillingCsv?Period=5%7C2026&CardDisplayId=${CARD_A}` },
      { href: `https://contactless.tfl.gov.uk/NewStatements?CardDisplayId=${CARD_B}` },
      { href: `/NewStatements/DownloadBillingCsv?Period=4%7C2026&CardDisplayId=${CARD_A}` },
      { href: '/help' },
    ],
    options: [CARD_C, 'not-a-card'],
  }), { fetch: fetchStub });
  ok(msgs.length === 1 && msgs[0].status === 'csv', 'script: statements fetched → one csv report');
  ok(msgs[0].files.length === 6, 'script: 3 cards × 2 periods = 6 statements, duplicates collapsed');
  ok(calls.length === 6 && calls.every(c => c.opts.credentials === 'include'),
    'script: every fetch carries the session cookie (credentials: include)');
  ok(calls[0].url === buildCsvUrl('7|2026', CARD_A) && calls[1].url === buildCsvUrl('6|2026', CARD_A),
    'script: fetch URLs match buildCsvUrl exactly — current month first, then previous');
  ok(msgs[0].files.every((f: any) => f.text === CSV_BODY && f.url.includes('DownloadBillingCsv')
    && /^\d{1,2}\|\d{4}$/.test(f.period) && /^[0-9a-f]{32}$/.test(f.card)),
    'script: each file carries text, card, period and URL for the import + endpoint log');
}
{
  // One month comes back as an HTML page (signed-out mid-way, TfL error page…)
  // — that statement is dropped, the rest still import.
  let n = 0;
  const flaky = () => {
    n++;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(n === 2 ? '<html>sign in</html>' : CSV_BODY),
    });
  };
  const msgs = await runDirect(statementsDoc({
    anchors: [{ href: `/x?CardDisplayId=${CARD_A}` }],
  }), { fetch: flaky });
  ok(msgs.length === 1 && msgs[0].status === 'csv' && msgs[0].files.length === 1,
    'script: an HTML response is dropped, surviving statements still reported');
}
{
  const msgs = await runDirect(statementsDoc({
    anchors: [{ href: `/x?CardDisplayId=${CARD_A}` }],
  }), { fetch: () => Promise.reject(new Error('WAF said no')) });
  ok(msgs.length === 1 && msgs[0].status === 'failed',
    'script: every fetch failing → failed (steering harvest takes over), not a crash');
}
{
  const msgs = await runDirect(statementsDoc({
    anchors: [{ href: `/x?CardDisplayId=${CARD_A}` }],
  }), { fetch: () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('') }) });
  ok(msgs.length === 1 && msgs[0].status === 'failed', 'script: non-OK responses count as failures too');
}
{
  const msgs = await runDirect(statementsDoc({ anchors: [{ href: '/help' }] }));
  ok(msgs.length === 1 && msgs[0].status === 'failed',
    'script: statements page with no card ids → failed, fallback decides');
}
{
  // Card cap: same spirit as MAX_CARDS in the steering flow.
  const many = Array.from({ length: MAX_DIRECT_CARDS + 4 }, (_, i) =>
    ({ href: `/x?CardDisplayId=${String(i).padStart(2, '0').repeat(16)}` }));
  const calls: string[] = [];
  const fetchStub = (url: string) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, text: () => Promise.resolve(CSV_BODY) });
  };
  const msgs = await runDirect(statementsDoc({ anchors: many }), { fetch: fetchStub });
  ok(msgs[0].status === 'csv' && calls.length === MAX_DIRECT_CARDS * 2,
    `script: card list capped at ${MAX_DIRECT_CARDS} — a pathological page can't fetch forever`);
}
{
  const hostile = { querySelector: () => { throw new Error('boom'); }, querySelectorAll: () => { throw new Error('boom'); } };
  const msgs = await runDirect(hostile);
  ok(msgs.length === 1 && msgs[0].status === 'failed',
    'script: hostile DOM reports failed instead of throwing into the page');
}

// --- flow: where a refresh starts, and the fallback path ---
function run(events: FlowEvent[], from: FlowState): FlowState {
  return events.reduce(reduceFlow, from);
}

ok(startUrlFor('contactless') === NEW_STATEMENTS_URL && startUrlFor('both') === NEW_STATEMENTS_URL,
  'flow: contactless modes start on the statements page for the direct fetch');
ok(startUrlFor('oyster') === OYSTER_HISTORY_URL, 'flow: Oyster has no statements endpoint — starts on its history');
{
  const s = makeInitialFlow('contactless');
  ok('home' in s && s.home === CONTACTLESS_HISTORY_URL,
    'flow: steering home stays the classic history page — that IS the fallback target');
}
{
  // Happy path: statements page loads, direct fetch succeeds, done — the csv
  // report rides the existing harvest-import path, zero steering.
  const s = run([
    { type: 'loaded', url: NEW_STATEMENTS_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 5 },
  ], makeInitialFlow('contactless'));
  ok(s.phase === 'done' && s.inserted === 5, 'flow: direct fetch happy path — loaded → csv → imported → done');
}
{
  // Fallback: direct fetch failed → steer to the history page, classic
  // steering harvest takes over.
  const s = run([
    { type: 'loaded', url: NEW_STATEMENTS_URL },
    { type: 'direct-failed' },
  ], makeInitialFlow('contactless'));
  ok(s.phase === 'steering' && s.target === CONTACTLESS_HISTORY_URL && s.steers === 1,
    'flow: direct-failed → steering to the contactless history (one steer spent)');
  const after = run([
    { type: 'loaded', url: CONTACTLESS_HISTORY_URL },
    { type: 'harvest', status: 'rows' },
    { type: 'imported', inserted: 2 },
  ], s);
  ok(after.phase === 'done' && after.inserted === 2, 'flow: the fallback harvest then completes normally');
}
{
  // 'both' mode: falling back must not skip contactless — Oyster stays queued
  // behind the steered-to contactless history.
  const s = run([
    { type: 'loaded', url: NEW_STATEMENTS_URL },
    { type: 'direct-failed' },
  ], makeInitialFlow('both'));
  ok(s.phase === 'steering' && s.target === CONTACTLESS_HISTORY_URL
    && 'queue' in s && s.queue.length === 1 && s.queue[0] === OYSTER_HISTORY_URL,
    'flow: both-mode fallback steers to contactless history with Oyster still queued');
}
{
  // 'both' mode happy path: direct csv covers contactless, then Oyster.
  const s = run([
    { type: 'loaded', url: NEW_STATEMENTS_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 3 },
  ], makeInitialFlow('both'));
  ok(s.phase === 'steering' && s.target === OYSTER_HISTORY_URL,
    'flow: both-mode direct success advances to the Oyster history next');
}
{
  const worn = { ...makeInitialFlow('contactless'), phase: 'harvesting' as const, steers: MAX_STEERS };
  const s = reduceFlow(worn, { type: 'direct-failed' });
  ok(s.phase === 'error', 'flow: direct-failed respects the steer cap — no ping-pong loops');
}
{
  const importing = { ...makeInitialFlow('contactless'), phase: 'importing' as const };
  ok(reduceFlow(importing, { type: 'direct-failed' }) === importing,
    'flow: a stale direct-failed outside harvesting is ignored');
  const paused = { ...makeInitialFlow('contactless'), phase: 'signed-out' as const };
  ok(reduceFlow(paused, { type: 'direct-failed' }) === paused,
    'flow: direct-failed never yanks a paused page from the user');
}

console.log(`\ntest-direct-csv: all ${passed} assertions passed.`);
