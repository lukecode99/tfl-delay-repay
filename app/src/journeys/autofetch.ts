// Journey-history auto-fetch (TfL-10). Pure module — node-testable.
//
// The user is already signed into their TfL account inside the claim WebView;
// the session cookie lives in the system WebView cookie store (shared via
// sharedCookiesEnabled on iOS). A hidden WebView navigates to the contactless
// journey-history page and runs the harvest script below: prefer the CSV
// export link (fetched from page context with the session cookie), fall back
// to scraping the journey table, and detect a signed-out redirect so the app
// can prompt for re-login instead of failing silently. Everything stays
// on-device: no credentials touched, no server involved.
//
// iOS only runs this while the app is foregrounded, so the fetch fires on app
// open / foreground / manual refresh — capped at one fetch per day.

/** Contactless journey history for the signed-in account. */
export const JOURNEY_HISTORY_URL = 'https://contactless.tfl.gov.uk/HomePage/7DayHistory';

/** Key in the journeys-db meta table recording the last successful fetch. */
export const LAST_AUTOFETCH_KEY = 'lastAutoFetch';

/**
 * One fetch per day. Was temporarily false for on-device testing of repeated
 * refreshes; restored for App Store submission (TFL-PRE-1).
 */
export const AUTOFETCH_RATE_LIMIT_ENABLED = true;

/**
 * Rate limit: at most one fetch per (UTC) calendar day — when enabled. A
 * signed-out or failed attempt is NOT stamped, so signing back in re-enables
 * Refresh immediately.
 */
export function shouldAutoFetch(lastFetchISO: string | null, nowISO: string): boolean {
  if (!AUTOFETCH_RATE_LIMIT_ENABLED) return true;
  return isNewFetchDay(lastFetchISO, nowISO);
}

/** Day comparison behind the rate limit. */
export function isNewFetchDay(lastFetchISO: string | null, nowISO: string): boolean {
  if (!lastFetchISO) return true;
  return lastFetchISO.slice(0, 10) !== nowISO.slice(0, 10);
}

/**
 * Card id for the auto-fetched statement when the export itself carries no
 * Card column: reuse the id the user's previous imports stored (most frequent
 * wins), so auto-fetched rows dedupe against manually imported ones no matter
 * what the original CSV file was called.
 */
export function pickCardId(existingCards: string[], fallback = 'contactless'): string {
  // TfL can list the same physical card more than once (Luke's account shows
  // two "Visa ending in 5006" entries, both expired-flagged), so ids that
  // mean the same card are grouped before counting: journey rows accrue to
  // the card, not to whichever variant of its name a statement used.
  const groups = new Map<string, Map<string, number>>();
  for (const c of existingCards) {
    if (!c || c === 'unknown') continue;
    const key = cardKey(c);
    const g = groups.get(key) ?? new Map<string, number>();
    g.set(c, (g.get(c) ?? 0) + 1);
    groups.set(key, g);
  }
  let bestGroup: Map<string, number> | null = null;
  let bestTotal = 0;
  for (const g of groups.values()) {
    let total = 0;
    for (const n of g.values()) total += n;
    if (total > bestTotal) { bestGroup = g; bestTotal = total; }
  }
  if (!bestGroup) return fallback;
  // Within the winning group, prefer a variant without an expired flag, then
  // the one with the most journey data behind it.
  let best = fallback;
  let bestScore = -1;
  for (const [raw, n] of bestGroup) {
    const score = (/expired/i.test(raw) ? 0 : 1_000_000) + n;
    if (score > bestScore) { bestScore = score; best = raw; }
  }
  return best;
}

/** Same-card grouping key: the PAN tail if one is present, else the name. */
function cardKey(c: string): string {
  const m = /ending in\s*(\d+)/i.exec(c) ?? /(\d{4,})/.exec(c);
  return m ? m[1] : c.trim().toLowerCase();
}

/**
 * CSV-endpoint discovery (TfL-13): capture, don't act. Any request that looks
 * like a journey export gets logged so the exact URL + params TfL uses can be
 * lifted from a device later — if the endpoint pins down, future refreshes
 * become one cookie-authenticated fetch instead of page steering.
 */
export const CSV_LOG_KEY = 'csvEndpointLog';

/** How many captured endpoint hits the meta log keeps. */
export const CSV_LOG_CAP = 20;

/** Does this URL smell like a journey-data export? Deliberately broad — the
 * log is capped and capture-only, so a false positive costs nothing. */
export function isCsvEndpoint(url: string): boolean {
  return /csv|export|download|statement/i.test(url);
}

/** Append a captured hit to the JSON log (stored in the db meta table),
 * tolerating a missing or corrupt existing value. Pure — caller supplies the
 * timestamp. */
export function appendCsvHit(
  existingJson: string | null,
  hit: { source: string; url: string; at: string },
  cap = CSV_LOG_CAP,
): string {
  let log: unknown[] = [];
  try {
    const parsed = JSON.parse(existingJson ?? '[]');
    if (Array.isArray(parsed)) log = parsed;
  } catch { /* corrupt log — start over */ }
  log.push(hit);
  return JSON.stringify(log.slice(-cap));
}

/** Scraped table rows → CSV text for the existing importCsvText pipeline. */
export function rowsToCsv(rows: string[][]): string {
  const esc = (c: string) => (/[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

/**
 * Injected-JS harvest script. Runs on whatever page the WebView landed on and
 * posts exactly one {type:'journey-harvest', status, ...} message:
 *   status 'challenge'           — robot-check page; wait for the user to solve it
 *   status 'signed-out'          — login (or mid-login) page; user signs in here
 *   status 'wrong-page', href    — signed-in but not on journey history; steer
 *   status 'cards', cards        — history page is a card picker; visit each
 *   status 'csv',  text, cards, url — CSV export fetched with the session cookie
 *   status 'rows', rows, cards   — journey table scraped (no export link)
 *   status 'empty'               — CONFIRMED journey-history page with no data
 *   status 'error', message      — harvest failed
 *
 * 'cards' entries are {href, label, expired} — Luke's account lists many
 * duplicate expired-flagged entries for the same PAN, so the flow (not this
 * script) decides which to visit: unexpired first, all of them if every entry
 * is expired-flagged. csv/rows also carry any card links found, so the other
 * cards on the account get their history checked too.
 *
 * 'empty' can only be reported from a page whose URL contains '7dayhistory'
 * or 'journeyhistory' (the Oyster site's marker, TfL-13) or that carries a
 * journey table — never from the My Account dashboard or any other
 * intermediate page (TfL-12).
 *
 * Kept as ES5 source text (not a serialised function): Hermes'
 * Function.prototype.toString returns "[bytecode]". The tests run this exact
 * string against a stub DOM.
 */
export function buildHarvestScript(): string {
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var win = window;
    var textOf = function (el) {
      return String(el && el.textContent != null ? el.textContent : '').replace(/\\s+/g, ' ').trim();
    };
    var href = '';
    try { href = String((win.location && win.location.href) || '').toLowerCase(); } catch (e) { }

    // Robot check? Cloudflare-style challenges are served at the requested
    // URL, so detection has to be DOM-based. Never harvest, never conclude —
    // the user solves it in the sheet and the page navigates on.
    var challenged = false;
    try {
      var title = String(doc.title || '').toLowerCase();
      if (/just a moment|attention required|verify you are human|are you a robot|security check/.test(title)) challenged = true;
      if (doc.querySelector('#challenge-form, #challenge-stage, #challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], [class*="cf-turnstile"]')) challenged = true;
    } catch (e) { }
    if (challenged) { report({ type: 'journey-harvest', status: 'challenge' }); return; }

    // Login page? The user signs in right here. Only actual sign-in pages —
    // the signed-in My Account dashboard also lives on account.tfl.gov.uk, so
    // matching the whole host would wrongly park the flow there (TfL-12).
    var signedOut = false;
    try {
      if (doc.querySelector('input[type="password"]')) signedOut = true;
      if (href.indexOf('signin') !== -1 || href.indexOf('sign-in') !== -1
        || href.indexOf('login') !== -1) signedOut = true;
    } catch (e) { }
    if (signedOut) { report({ type: 'journey-harvest', status: 'signed-out' }); return; }

    // Payment cards linked from this page, with any expired flag TfL shows
    // next to them. The flow decides which to visit.
    var collectCards = function () {
      var cards = [];
      var seen = {};
      try {
        var cas = doc.querySelectorAll('a[href]');
        for (var k = 0; k < cas.length; k++) {
          var ca = cas[k];
          var label = textOf(ca);
          if (!/(ending in\\s*\\d{2,4})|([•·*]{1,4}\\s*\\d{4})/i.test(label)) continue;
          var curl = String(ca.href || (ca.getAttribute && ca.getAttribute('href')) || '');
          if (!curl || seen[curl]) continue;
          seen[curl] = true;
          var context = label;
          try { if (ca.parentElement) context = textOf(ca.parentElement); } catch (e) { }
          cards.push({ href: curl, label: label, expired: /expired/i.test(context) });
        }
      } catch (e) { }
      return cards;
    };

    // Find the journey table, if this page has one.
    var rows = null;
    try {
      var tables = doc.querySelectorAll('table');
      for (var t = 0; t < tables.length; t++) {
        var trs = tables[t].querySelectorAll('tr');
        var cand = [];
        for (var r = 0; r < trs.length; r++) {
          var cells = trs[r].querySelectorAll('th, td');
          var row = [];
          for (var c = 0; c < cells.length; c++) { row.push(textOf(cells[c])); }
          if (row.length) cand.push(row);
        }
        if (!cand.length) continue;
        // Only the journey-history table — the page has other tables.
        var head = cand[0].join(' ').toLowerCase();
        if (head.indexOf('date') !== -1 && head.indexOf('journey') !== -1) { rows = cand; break; }
      }
    } catch (e) {
      report({ type: 'journey-harvest', status: 'error', message: String(e) });
      return;
    }

    // Are we actually ON the journey-history page? URL marker, or the journey
    // table itself as the DOM marker. Anywhere else is a page to steer away
    // from — post-login/post-challenge TfL likes to land on the dashboard.
    var onHistory = href.indexOf('7dayhistory') !== -1 || href.indexOf('journeyhistory') !== -1 || !!rows;
    if (!onHistory) {
      var signedIn = false;
      try {
        if (doc.body && /welcome back/i.test(textOf(doc.body))) signedIn = true;
      } catch (e) { }
      try {
        var outs = doc.querySelectorAll('a[href]');
        for (var o = 0; o < outs.length; o++) {
          var otext = textOf(outs[o]).toLowerCase();
          var ohref = String((outs[o].getAttribute && outs[o].getAttribute('href')) || outs[o].href || '').toLowerCase();
          if (otext.indexOf('sign out') !== -1 || otext.indexOf('log out') !== -1
            || ohref.indexOf('signout') !== -1 || ohref.indexOf('logout') !== -1) { signedIn = true; break; }
        }
      } catch (e) { }
      // On the account host with no sign-out link and no password field:
      // probably mid-login (2FA, verification) — wait, don't yank the page.
      if (!signedIn && href.indexOf('account.tfl.gov.uk') !== -1) {
        report({ type: 'journey-harvest', status: 'signed-out' });
        return;
      }
      report({ type: 'journey-harvest', status: 'wrong-page', href: href });
      return;
    }

    // On the history page. Any card switcher here lists the account's other
    // cards — reported alongside the data so their history gets checked too.
    var cards = collectCards();
    var conclude = function () {
      if (rows) { report({ type: 'journey-harvest', status: 'rows', rows: rows, cards: cards }); return; }
      if (cards.length) { report({ type: 'journey-harvest', status: 'cards', cards: cards }); return; }
      report({ type: 'journey-harvest', status: 'empty' });
    };

    // Prefer the CSV export link — same data the manual download gives, and
    // the existing parser already speaks it. Fetched from page context so the
    // session cookie rides along.
    var link = null;
    try {
      var anchors = doc.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var ahref = String((a.getAttribute && a.getAttribute('href')) || a.href || '');
        if (/csv/i.test(ahref) || /csv/i.test(textOf(a))) { link = a; break; }
      }
    } catch (e) { }
    if (link && win.fetch) {
      var url = link.href || link.getAttribute('href');
      win.fetch(url, { credentials: 'include' })
        .then(function (res) {
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          return res.text();
        })
        .then(function (t) { report({ type: 'journey-harvest', status: 'csv', text: t, cards: cards, url: String(url) }); })
        .catch(function () { conclude(); });
      return;
    }
    conclude();
  } catch (e) {
    report({ type: 'journey-harvest', status: 'error', message: String(e) });
  }
})(); true;`;
}

/**
 * Injected network probe (TfL-13): wraps fetch and XMLHttpRequest.open so any
 * export-looking request the page (or the harvest script itself) fires gets
 * reported as {type:'net-probe', kind, url} — pure observation, requests pass
 * through untouched. Injected ONLY alongside the harvest script (never on
 * login/challenge pages), idempotent per page. ES5 source text for the same
 * Hermes reason as the harvest script; tests run this exact string.
 */
export function buildNetProbeScript(): string {
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var win = window;
    if (win.__tflNetProbe) { return; }
    win.__tflNetProbe = true;
    var interesting = function (u) { return /csv|export|download|statement/i.test(String(u)); };
    var post = function (kind, u) {
      try { report({ type: 'net-probe', kind: kind, url: String(u) }); } catch (e) { }
    };
    if (win.fetch) {
      var origFetch = win.fetch;
      win.fetch = function (input) {
        try {
          var u = input && input.url ? input.url : input;
          if (interesting(u)) { post('fetch', u); }
        } catch (e) { }
        return origFetch.apply(win, arguments);
      };
    }
    if (win.XMLHttpRequest && win.XMLHttpRequest.prototype && win.XMLHttpRequest.prototype.open) {
      var origOpen = win.XMLHttpRequest.prototype.open;
      win.XMLHttpRequest.prototype.open = function (method, url) {
        try { if (interesting(url)) { post('xhr', String(method).toUpperCase() + ' ' + String(url)); } } catch (e) { }
        return origOpen.apply(this, arguments);
      };
    }
  } catch (e) { }
})(); true;`;
}
