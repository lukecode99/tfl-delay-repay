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
 * TEMPORARY: rate limiting is switched off while Luke tests repeated
 * refreshes on device. Set back to true to restore one fetch per day.
 */
export const AUTOFETCH_RATE_LIMIT_ENABLED = false;

/**
 * Rate limit: at most one fetch per (UTC) calendar day — when enabled. A
 * signed-out or failed attempt is NOT stamped, so signing back in re-enables
 * Refresh immediately.
 */
export function shouldAutoFetch(lastFetchISO: string | null, nowISO: string): boolean {
  if (!AUTOFETCH_RATE_LIMIT_ENABLED) return true;
  return isNewFetchDay(lastFetchISO, nowISO);
}

/** Day comparison behind the rate limit — kept tested while the limit is off. */
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
  const counts = new Map<string, number>();
  for (const c of existingCards) {
    if (c && c !== 'unknown') counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) { best = c; bestN = n; }
  }
  return best ?? fallback;
}

/** Scraped table rows → CSV text for the existing importCsvText pipeline. */
export function rowsToCsv(rows: string[][]): string {
  const esc = (c: string) => (/[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

/**
 * Injected-JS harvest script for the journey-history page. Posts exactly one
 * {type:'journey-harvest', status, ...} message:
 *   status 'signed-out'          — login page detected; session expired
 *   status 'csv',  text          — CSV export fetched with the session cookie
 *   status 'rows', rows          — journey table scraped (no export link)
 *   status 'empty'               — page loaded but no journey data found
 *   status 'error', message      — harvest failed
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

    // Signed out? The history page redirects to the account sign-in when the
    // session has expired.
    var signedOut = false;
    try {
      if (doc.querySelector('input[type="password"]')) signedOut = true;
      var href = String((win.location && win.location.href) || '').toLowerCase();
      if (href.indexOf('signin') !== -1 || href.indexOf('sign-in') !== -1
        || href.indexOf('login') !== -1 || href.indexOf('account.tfl.gov.uk') !== -1) signedOut = true;
    } catch (e) { }
    if (signedOut) { report({ type: 'journey-harvest', status: 'signed-out' }); return; }

    var scrape = function () {
      try {
        var tables = doc.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
          var trs = tables[t].querySelectorAll('tr');
          var rows = [];
          for (var r = 0; r < trs.length; r++) {
            var cells = trs[r].querySelectorAll('th, td');
            var row = [];
            for (var c = 0; c < cells.length; c++) { row.push(textOf(cells[c])); }
            if (row.length) rows.push(row);
          }
          if (!rows.length) continue;
          // Only the journey-history table — the page has other tables.
          var head = rows[0].join(' ').toLowerCase();
          if (head.indexOf('date') !== -1 && head.indexOf('journey') !== -1) {
            report({ type: 'journey-harvest', status: 'rows', rows: rows });
            return;
          }
        }
        report({ type: 'journey-harvest', status: 'empty' });
      } catch (e) {
        report({ type: 'journey-harvest', status: 'error', message: String(e) });
      }
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
        .then(function (t) { report({ type: 'journey-harvest', status: 'csv', text: t }); })
        .catch(function () { scrape(); });
      return;
    }
    scrape();
  } catch (e) {
    report({ type: 'journey-harvest', status: 'error', message: String(e) });
  }
})(); true;`;
}
