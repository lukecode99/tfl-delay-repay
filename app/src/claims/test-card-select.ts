// card-selection steer tests — run with:
//   node --experimental-strip-types src/claims/test-card-select.ts
import assert from 'node:assert/strict';
import {
  buildCardSelectScript,
  cardIdFromSelectBody,
  CLAIM_APPLY_PATH,
  CONTACTLESS_MYCARDS_URL,
  isDashboardPage,
  isLoginRedirectUrl,
  isMyCardsPage,
  lastFourOf,
  tidyNavLogUrl,
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

// ── TfL-32: learn-the-card from a genuine manual tap (xhr SelectedCard body) ──────
ok(cardIdFromSelectBody('cardDisplayId=' + CARD_A) === CARD_A, 'cardIdFromSelectBody pulls the 32-hex id from a select body');
ok(cardIdFromSelectBody('cardDisplayId=' + CARD_A + '&__RequestVerificationToken=x') === CARD_A, 'cardIdFromSelectBody ignores trailing fields');
ok(cardIdFromSelectBody('CardDisplayId=' + CARD_A.toUpperCase()) === CARD_A.toUpperCase(), 'cardIdFromSelectBody is case-insensitive on the key');
ok(cardIdFromSelectBody('foo=bar') === '', 'cardIdFromSelectBody → "" when no cardDisplayId present');
ok(cardIdFromSelectBody('cardDisplayId=notahexid') === '', 'cardIdFromSelectBody → "" when value is not 32 hex');
ok(cardIdFromSelectBody(null) === '' && cardIdFromSelectBody(undefined) === '', 'cardIdFromSelectBody tolerates null/undefined');

// ── TfL-32: tidy the Azure B2C sign-in noise out of the audit log ─────────────────
ok(tidyNavLogUrl('https://account.tfl.gov.uk/oauth2/v2.0/authorize?id_token_hint=eyJ&nonce=abc') === 'https://account.tfl.gov.uk/oauth2/v2.0/authorize?…', 'tidyNavLogUrl strips the B2C authorize query');
ok(tidyNavLogUrl('https://contactless.tfl.gov.uk/signin-oidc?code=zzz&state=yyy') === 'https://contactless.tfl.gov.uk/signin-oidc?…', 'tidyNavLogUrl strips the signin-oidc callback query');
ok(tidyNavLogUrl('https://account.tfl.gov.uk/logout') === 'https://account.tfl.gov.uk/logout', 'tidyNavLogUrl leaves a sign-in host alone when it has no query');
const applyUrl = 'https://contactless.tfl.gov.uk/ServiceDelayRefunds/Apply?cardDisplayId=' + CARD_A;
ok(tidyNavLogUrl(applyUrl) === applyUrl, 'tidyNavLogUrl keeps the Apply ?cardDisplayId= query intact');
ok(tidyNavLogUrl('https://contactless.tfl.gov.uk/MyCards') === 'https://contactless.tfl.gov.uk/MyCards', 'tidyNavLogUrl passes non-sign-in URLs through unchanged');
ok(tidyNavLogUrl('') === '', 'tidyNavLogUrl tolerates empty input');

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
  cards?: Array<{ id: string; status?: 'active' | 'expired' | 'unknown'; last4?: string; href?: string }>; // TfL-33/34 DOM mock
  claimLast4?: string | null; // TfL-34: the claim journey's card last-4
  fetchResolves?: boolean; // true → onFulfilled, false → onRejected
  fetchOk?: boolean; // HTTP response.ok (default true → 2xx)
  fetchStatus?: number; // HTTP status code passed to .then
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
  // TfL-33: when opts.cards is given, build a realistic MyCards DOM — each card is
  // an <a> whose own block carries a status label ("Ready for travel" / "Card has
  // expired" / "Unable to travel") and exactly one "Reference number". querySelectorAll
  // returns those anchors so the classifier can tag each card by its block status.
  let cardAnchors: any[] | null = null;
  let cardsHtml = '';
  if (opts.cards) {
    cardAnchors = opts.cards.map((c) => {
      const statusText =
        c.status === 'active' ? '✓ Ready for travel'
          : c.status === 'expired' ? '⚠️ Card has expired — Unable to travel'
            : '';
      const href = c.href ?? (CLAIM_APPLY_PATH + '?cardDisplayId=' + c.id);
      // block = smallest ancestor with exactly one "Reference number" label.
      const block: any = { textContent: `ending in ${c.last4 ?? '0000'} ${statusText} Expires: 04/2030 Reference number: 100000000`, parentNode: null };
      const anchor: any = {
        getAttribute: (k: string) => (k === 'href' ? href : null),
        parentNode: block,
      };
      block.parentNode = { textContent: '', parentNode: null }; // outer wrapper, harmless
      cardsHtml += `<a href="${href}">card</a>`;
      return anchor;
    });
  }
  const doc: any = {
    querySelector: (sel: string) => (sel.indexOf('__RequestVerificationToken') >= 0 ? tokenInput : null),
    querySelectorAll: cardAnchors ? (sel: string) => (sel === 'a' ? cardAnchors : []) : undefined,
    documentElement: { innerHTML: opts.cards ? (opts.html ?? '') + cardsHtml : (opts.html ?? '') },
  };
  const resolves = opts.fetchResolves !== false;
  const res = { ok: opts.fetchOk !== false, status: opts.fetchStatus ?? 200 };
  const fetch = (url: string, o: any) => {
    fetched = { url, opts: o };
    return {
      then: (onF: (r: any) => void, onR: (e: any) => void) => {
        if (resolves) { onF(res); } else { onR(new Error('network')); }
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
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', buildCardSelectScript(opts.preferred, opts.claimLast4))(
    win, doc, location, fetch, setInterval, clearInterval,
  );
  return { posted, fetched, located: location.href === startHref ? null : location.href };
}

// Happy path: stored id present *on the page* + token → selects card, navigates to Apply.
{
  const html = `<a href="/Card/${CARD_A}/History">card</a>`;
  const r = runSelect({ preferred: CARD_A, token: TOKEN, html });
  const sel = r.posted.filter((p: any) => p.type === 'card-select');
  ok(r.posted.some((p: any) => p.type === 'card-diag'), 'emits a card-diag probe on MyCards');
  ok(sel.filter((p: any) => p.ok === true && p.stage === 'posting').length === 1, 'posts one card-select ok:true/posting');
  ok(sel.some((p: any) => p.ok === true && p.stage === 'selected'), 'posts card-select ok:true/selected on 2xx');
  ok(!!r.fetched && r.fetched.url === '/Card/SelectedCard', 'POSTs to /Card/SelectedCard');
  ok(!!r.fetched && r.fetched.opts.method === 'POST', 'uses POST');
  ok(!!r.fetched && r.fetched.opts.credentials === 'include', 'sends credentials (session cookie)');
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'body carries the cardDisplayId');
  ok(!!r.fetched && r.fetched.opts.body.indexOf('__RequestVerificationToken=' + TOKEN) >= 0, 'body carries the anti-forgery token');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_A, 'navigates to Apply WITH ?cardDisplayId= on success');
}

// TfL-31: stored id is NOT on the page → ignore it, use the page's own id (the
// build-82 404 cause: we POSTed a foreign stored id the MyCards page never listed).
{
  const stale = 'ffffffffffffffffffffffffffffffff';
  const html = `<a href="/Card/${CARD_A}/History">card</a>`;
  const r = runSelect({ preferred: stale, token: TOKEN, html });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'uses the page id, not the stale stored id');
  ok(!!r.fetched && r.fetched.opts.body.indexOf(stale) < 0, 'stale stored id never leaves the device');
}

// TfL-31: selection endpoint 404s → do NOT navigate to Apply; report select-http.
{
  const html = `<a href="/Card/${CARD_A}/History">card</a>`;
  const r = runSelect({ preferred: CARD_A, token: TOKEN, html, fetchOk: false, fetchStatus: 404 });
  ok(r.located === null, '404 select → stays on MyCards (no card-less Apply bounce)');
  const fail = r.posted.filter((p: any) => p.ok === false && p.reason === 'select-http');
  ok(fail.length === 1 && fail[0].status === 404, '404 select → posts ok:false reason:select-http status:404');
}

// DOM-scan fallback: no preferred id, but the page HTML carries a CardDisplayId link.
{
  const html = `<a href="/NewStatements/Billing?CardDisplayId=${CARD_A}">statement</a>`;
  const r = runSelect({ preferred: null, token: TOKEN, html });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'scans the page for a CardDisplayId when none stored');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_A, 'DOM-scan path reaches Apply WITH ?cardDisplayId=');
}

// TfL-31: MULTIPLE cards, none matching the stored id → do NOT guess a card.
// Report ambiguous-cards so the UI asks the user to tap (filing against the wrong
// card is worse than one tap). Luke 22-Oct: page listed 02821f09/f8985f9d/5a806fcd.
{
  const CARD_B = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const html = `<a href="/Card/${CARD_A}/x">one</a><a href="/Card/${CARD_B}/x">two</a>`;
  const r = runSelect({ preferred: null, token: TOKEN, html });
  ok(r.fetched === null, 'multiple cards, no stored match → does NOT POST a guessed card');
  ok(r.located === null, 'multiple cards → stays on MyCards for a manual tap');
  const amb = r.posted.filter((p: any) => p.type === 'card-select' && p.ok === false && p.reason === 'ambiguous-cards');
  ok(amb.length === 1 && amb[0].count === 2, 'multiple cards → posts ok:false reason:ambiguous-cards count:2');
}

// TfL-31: multiple cards BUT the stored id is one of them → use the stored id.
{
  const CARD_B = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const html = `<a href="/Card/${CARD_A}/x">one</a><a href="/Card/${CARD_B}/x">two</a>`;
  const r = runSelect({ preferred: CARD_B, token: TOKEN, html });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_B) >= 0, 'stored id present among many → selects it');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_B, 'stored-among-many → Apply WITH its ?cardDisplayId=');
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
  const html = `<a href="/Card/${CARD_A}/History">card</a>`;
  const r = runSelect({ preferred: CARD_A, token: TOKEN, html, fetchResolves: false });
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
    documentElement: { innerHTML: `<a href="/Card/${CARD_A}/x">c</a>` },
  };
  const fetch = () => ({ then: (f: (r: any) => void) => { f({ ok: true, status: 200 }); return { then: () => {} }; } });
  const si = () => 1; const ci = () => {};
  const script = buildCardSelectScript(CARD_A);
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(win, doc, location, fetch, si, ci);
  new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(win, doc, location, fetch, si, ci);
  ok(posted.filter((p: any) => p.type === 'card-select' && p.stage === 'posting').length === 1, 'window.__tflCardSelect latch prevents a double selection');
}

// ── TfL-33: status-based auto-select across many cards (Luke 23-Oct) ──────────────
const CARD_B = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const CARD_C = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7';
const CARD_D = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';

// (a) 6-card reality: 5 expired + 1 "Ready for travel" → auto-select the active one, zero taps.
{
  const r = runSelect({
    preferred: null, token: TOKEN,
    cards: [
      { id: CARD_A, status: 'expired' },
      { id: CARD_B, status: 'expired' },
      { id: CARD_C, status: 'expired' },
      { id: CARD_D, status: 'active' },
    ],
  });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_D) >= 0, 'many cards, one active → POSTs the travel-ready card');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_D, 'one active card → navigates straight to Apply (no tap)');
  const amb = r.posted.filter((p: any) => p.type === 'card-select' && p.reason === 'ambiguous-cards');
  ok(amb.length === 0, 'one active card → never reports ambiguous');
}

// (b) two "Ready for travel" cards, none learned → still refuse to guess.
{
  const r = runSelect({
    preferred: null, token: TOKEN,
    cards: [
      { id: CARD_A, status: 'active' },
      { id: CARD_B, status: 'active' },
      { id: CARD_C, status: 'expired' },
    ],
  });
  ok(r.fetched === null, 'two active cards, none learned → does NOT guess a card');
  ok(r.located === null, 'two active cards → stays on MyCards for a tap');
  const amb = r.posted.filter((p: any) => p.type === 'card-select' && p.reason === 'ambiguous-cards');
  ok(amb.length === 1 && amb[0].count === 3 && amb[0].active === 2, 'two active → ambiguous count:3 active:2');
}

// (c) a learned card among several actives wins outright.
{
  const r = runSelect({
    preferred: CARD_B, token: TOKEN,
    cards: [
      { id: CARD_A, status: 'active' },
      { id: CARD_B, status: 'active' },
    ],
  });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_B) >= 0, 'learned card among actives → selects the learned one');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_B, 'learned-among-actives → Apply with its id');
}

// (d) every card expired → ambiguous with active:0, no POST (nothing travel-ready).
{
  const r = runSelect({
    preferred: null, token: TOKEN,
    cards: [
      { id: CARD_A, status: 'expired' },
      { id: CARD_B, status: 'expired' },
    ],
  });
  ok(r.fetched === null, 'all cards expired → does NOT POST');
  const amb = r.posted.filter((p: any) => p.type === 'card-select' && p.reason === 'ambiguous-cards');
  ok(amb.length === 1 && amb[0].active === 0, 'all expired → ambiguous active:0');
}

// ── TfL-34: pull the card last-4 from a label / block ─────────────────────────────
ok(lastFourOf('Visa ending in 5006') === '5006', 'lastFourOf reads "ending in 5006"');
ok(lastFourOf('Mastercard •••• 4886') === '4886', 'lastFourOf reads the bullet-masked form');
ok(lastFourOf('card with no number') === '', 'lastFourOf → "" when no digits');
ok(lastFourOf(null) === '' && lastFourOf(undefined) === '', 'lastFourOf tolerates null/undefined');

// ── TfL-34: last-4 tiebreaker across multiple travel-ready cards (Luke 23-Oct) ─────

// (e) two active cards, DIFFERENT last-4s, claim is for 5006 → pick the 5006 card.
{
  const r = runSelect({
    preferred: null, token: TOKEN, claimLast4: '5006',
    cards: [
      { id: CARD_A, status: 'active', last4: '1234' },
      { id: CARD_B, status: 'active', last4: '5006' },
      { id: CARD_C, status: 'expired', last4: '9999' },
    ],
  });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_B) >= 0, 'two actives, claim last-4 matches one → selects that card');
  ok(r.located === CLAIM_APPLY_PATH + '?cardDisplayId=' + CARD_B, 'last-4 match → navigates straight to Apply (no tap)');
}

// (f) two active cards SHARING the claim's last-4 (Luke's reissues) → still can't choose.
{
  const r = runSelect({
    preferred: null, token: TOKEN, claimLast4: '5006',
    cards: [
      { id: CARD_A, status: 'active', last4: '5006' },
      { id: CARD_B, status: 'active', last4: '5006' },
    ],
  });
  ok(r.fetched === null, 'two actives same last-4 → does NOT guess');
  const amb = r.posted.filter((p: any) => p.type === 'card-select' && p.reason === 'ambiguous-cards');
  ok(amb.length === 1 && amb[0].active === 2 && amb[0].matched === 2, 'shared last-4 → ambiguous active:2 matched:2');
}

// (g) claim last-4 matches NO active card → fall back to the single-active rule.
{
  const r = runSelect({
    preferred: null, token: TOKEN, claimLast4: '7777',
    cards: [
      { id: CARD_A, status: 'active', last4: '5006' },
      { id: CARD_B, status: 'expired', last4: '1234' },
    ],
  });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'no last-4 match but one active → still selects the active card');
}

// (h) learned card still outranks a last-4 match.
{
  const r = runSelect({
    preferred: CARD_A, token: TOKEN, claimLast4: '5006',
    cards: [
      { id: CARD_A, status: 'active', last4: '1234' },
      { id: CARD_B, status: 'active', last4: '5006' },
    ],
  });
  ok(!!r.fetched && r.fetched.opts.body.indexOf('cardDisplayId=' + CARD_A) >= 0, 'learned card wins over a last-4 match');
}

console.log(`\ntest-card-select: all ${passed} assertions passed`);
