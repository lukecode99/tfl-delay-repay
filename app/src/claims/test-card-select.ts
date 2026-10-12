// card-selection steer tests — run with:
//   node --experimental-strip-types src/claims/test-card-select.ts
import assert from 'node:assert/strict';
import {
  buildCardSelectScript,
  CLAIM_APPLY_PATH,
  CONTACTLESS_MYCARDS_URL,
  isDashboardPage,
  isLoginRedirectUrl,
  isMyCardsPage,
} from './card-select.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const CARD_A = 'df244eb2d1e74e7e8bd1944ecb0d2e86'; // 32 hex
const TOKEN = 'CfDJ8-fake-anti-forgery-token';

// ── page matchers ──────────────────────────────────────────────────────────────
ok(isMyCardsPage('https://contactless.tfl.gov.uk/MyCards'), 'MyCards (bare) → true');
ok(isMyCardsPage('https://contactless.tfl.gov.uk/MyCards/'), 'MyCards (trailing slash) → true');
ok(isMyCardsPage('https://contactless.tfl.gov.uk/MyCards?x=1'), 'MyCards (query) → true');
ok(!isMyCardsPage('https://contactless.tfl.gov.uk/MyCardsOld'), 'MyCardsOld → false (word boundary)');
ok(!isMyCardsPage('https://contactless.tfl.gov.uk/ServiceDelayRefunds/Apply'), 'Apply → not MyCards');
ok(isDashboardPage('https://contactless.tfl.gov.uk/Dashboard'), 'Dashboard → true');
ok(!isDashboardPage('https://contactless.tfl.gov.uk/MyCards'), 'MyCards → not Dashboard');

// ── TfL-29: sign-in bounce detection resets the one-shot steer guards ─────────────
// The real 11-Oct evening cold-session claim sequence; each of these must reset so
// card-selection re-fires on the post-login MyCards instead of stranding the user.
ok(isLoginRedirectUrl('https://contactless.tfl.gov.uk/HomePage/LoginTimedOut'), 'LoginTimedOut → sign-in bounce');
ok(isLoginRedirectUrl('https://contactless.tfl.gov.uk/HomePage/LoginTimedOut?ReturnUrl=%2fHomePage%2fLoginTimedOut'), 'LoginTimedOut (ReturnUrl) → sign-in bounce');
ok(isLoginRedirectUrl('https://account.tfl.gov.uk/c00064e1-def7-4087-8468-a50e3894f95e/oauth2/v2.0/authorize?p=b2c_1a_signin'), 'B2C authorize → sign-in bounce');
ok(isLoginRedirectUrl('https://contactless.tfl.gov.uk/signin-oidc'), 'signin-oidc callback → sign-in bounce');
ok(isLoginRedirectUrl('https://contactless.tfl.gov.uk/HomePage/Login'), 'HomePage/Login → sign-in bounce');
// Real content pages must NOT read as a bounce, or the steer would reset forever and never fire.
ok(!isLoginRedirectUrl('https://contactless.tfl.gov.uk/MyCards'), 'MyCards → not a bounce');
ok(!isLoginRedirectUrl('https://contactless.tfl.gov.uk/Dashboard'), 'Dashboard → not a bounce');
ok(!isLoginRedirectUrl('https://contactless.tfl.gov.uk/ServiceDelayRefunds/Apply?cardDisplayId=' + CARD_A), 'Apply → not a bounce');
ok(!isLoginRedirectUrl('https://contactless.tfl.gov.uk/HomePage/ValidateOAuth'), 'ValidateOAuth (post-login) → not a bounce');

// ── injected script behaviour (ES5, run via new Function) ────────────────────────

interface Run {
  posted: any[];
  fetched: { url: string; opts: any } | null;
  located: string | null;
}

function runSelect(opts: {
  preferred?: string | null;
  href?: string;
  token?: string | null; // null → no hidden input
  html?: string; // documentElement.innerHTML for the DOM-scan fallback
  fetchResolves?: boolean; // true → onFulfilled, false → onRejected
  autoPoll?: boolean; // whether setInterval fires its callback
}): Run {
  const startHref = opts.href ?? CONTACTLESS_MYCARDS_URL;
  const posted: any[] = [];
  let fetched: { url: string; opts: any } | null = null;
  const location: any = { href: startHref };
  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    location,
  };
  const tokenInput = opts.token === null ? null : { value: opts.token ?? TOKEN, getAttribute: () => opts.token ?? TOKEN };
  const doc: any = {
    querySelector: (sel: string) => (sel.indexOf('__RequestVerificationToken') >= 0 ? tokenInput : null),
    documentElement: { innerHTML: opts.html ?? '' },
  };
  const resolves = opts.fetchResolves !== false;
  const fetch = (url: string, o: any) => {
    fetched = { url, opts: o };
    return {
      then: (onF: () => void, onR: (e: any) => void) => {
        if (resolves) { onF(); } else { onR(new Error('network')); }
        return { then: () => {} };
      },
    };
  };
  // setInterval: by default do not tick (prove the first synchronous attempt is
  // enough on a ready page); autoPoll runs the callback until the script clears
  // it (mirrors a real timer so the timeout branch fires exactly once).
  let cleared = false;
  const clearInterval = (_: any) => { cleared = true; };
  const setInterval = (fn: () => void) => {
    if (opts.autoPoll) { for (let i = 0; i < 12 && !cleared; i++) fn(); }
    return 1;
  };
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', buildCardSelectScript(opts.preferred))(
    win, doc, location, fetch, setInterval, clearInterval,
  );
  return { posted, fetched, located: location.href === startHref ? null : location.href };
}

// Happy path: preferred id + token present → selects card, posts, navigates to Apply.
{
  const r = runSelect({ preferred: CARD_A, token: TOKEN });
  const sel = r.posted.filter((p: any) => p.type === 'card-select');
  ok(r.posted.some((p: any) => p.type === 'card-diag'), 'emits a card-diag probe on MyCards');
  ok(sel.length === 1 && sel[0].ok === true, 'posts card-select ok:true');
  ok(!!r.fetched && r.fetched.url === '/Card/SelectedCard', 'POSTs to /Card/SelectedCard');
  ok(!!r.fetched && r.fetched.opts.method === 'POST', 'uses POST');
  ok(!!r.fetched && r.fetched.opts.credentials === 'include', 'sends credentials (session cookie)');
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'body carries the cardDisplayId');
  ok(!!r.fetched && r.fetched.opts.body.indexOf('__RequestVerificationToken=' + TOKEN) >= 0, 'body carries the anti-forgery token');
  ok(r.located === CLAIM_APPLY_PATH, 'navigates to the Apply form on success');
}

// DOM-scan fallback: no preferred id, but the page HTML carries a CardDisplayId link.
{
  const html = `<a href="/NewStatements/Billing?CardDisplayId=${CARD_A}">statement</a>`;
  const r = runSelect({ preferred: null, token: TOKEN, html });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'scans the page for a CardDisplayId when none stored');
  ok(r.located === CLAIM_APPLY_PATH, 'DOM-scan path still reaches Apply');
}

// DOM-scan fallback via /Card/<id> path form.
{
  const html = `<a href="/Card/${CARD_A}/History">history</a>`;
  const r = runSelect({ preferred: '', token: TOKEN, html });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'scans /Card/<id> path form too');
}

// No token → does not POST, does not navigate (first attempt fails; interval idle in test).
{
  const r = runSelect({ preferred: CARD_A, token: null });
  ok(r.fetched === null, 'no anti-forgery token → does not POST');
  ok(r.located === null, 'no token → stays on MyCards');
  ok(r.posted.filter((p: any) => p.type === 'card-select').length === 0, 'no token → posts no card-select synchronously');
}

// No card id anywhere → does not POST.
{
  const r = runSelect({ preferred: null, token: TOKEN, html: '<p>no cards here</p>' });
  ok(r.fetched === null, 'no card id → does not POST');
}

// Not on MyCards (guard) → no-op even with everything present.
{
  const r = runSelect({ preferred: CARD_A, token: TOKEN, href: 'https://contactless.tfl.gov.uk/Dashboard' });
  ok(r.fetched === null && r.posted.length === 0, 'guard: does nothing off the MyCards page');
}

// fetch rejects → reports the failure, does not navigate.
{
  const r = runSelect({ preferred: CARD_A, token: TOKEN, fetchResolves: false });
  ok(r.located === null, 'POST failure → does not navigate to Apply');
  const fail = r.posted.filter((p: any) => p.ok === false && p.reason === 'post-failed');
  ok(fail.length === 1, 'POST failure → posts ok:false reason:post-failed');
}

// Timeout path: never finds a token across all polls → posts a single timeout.
{
  const r = runSelect({ preferred: CARD_A, token: null, autoPoll: true });
  const timeouts = r.posted.filter((p: any) => p.ok === false && p.reason === 'timeout');
  ok(timeouts.length === 1, 'exhausted polling → one timeout report');
}

// Latch: a second injection into the same page is a no-op.
{
  const posted: any[] = [];
  const location: any = { href: CONTACTLESS_MYCARDS_URL };
  const win: any = { ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) }, location, __tflCardSelect: false };
  const doc: any = {
    querySelector: () => ({ value: TOKEN, getAttribute: () => TOKEN }),
    documentElement: { innerHTML: '' },
  };
  const fetch = () => ({ then: (f: () => void) => { f(); return { then: () => {} }; } });
  const si = () => 1; const ci = () => {};
  const script = buildCardSelectScript(CARD_A);
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(win, doc, location, fetch, si, ci);
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(win, doc, location, fetch, si, ci);
  ok(posted.filter((p: any) => p.type === 'card-select').length === 1, 'window.__tflCardSelect latch prevents a double selection');
}

console.log(`\ntest-card-select: all ${passed} assertions passed`);
