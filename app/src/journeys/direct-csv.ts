// Direct CSV fetch (TfL-14/18/19). Pure module — node-testable.
//
// TfL serves each month's journey history as a CSV from a stable endpoint:
// NewStatements/DownloadJourneyCsv?Period=<month>|<year>&CardDisplayId=
// <32-hex id>. TfL-19: builds 13–15 fetched DownloadBillingCsv — the sibling
// endpoint the TfL-13 endpoint log happened to capture first. Billing CSVs
// are payment statements: they pass the header guard (they have a Date
// column) but hold no journey rows, so every fetch "succeeded" and imported
// zero. A device audit log walking MyCards → Statements → Download proved
// the journey statement lives at DownloadJourneyCsv (same query shape).
// The NewStatements PAGE itself was removed by TfL (TfL-18: 302 →
// Error/NotFound) but the endpoint under it survives and is same-origin from
// any contactless page — so the script below runs IN PLACE on whatever
// signed-in contactless page the flow is showing. Card ids come from the
// MyCards page (TfL-19: fetched same-origin and mined for CardDisplayId
// links — the account's ACTIVE cards, with nothing hardcoded), then the
// current page, then previously captured ids passed in as knownCards. Each
// card fetches current + previous month's CSV (the previous month covers
// journeys near the start of a month, well inside the 28-day Delay Repay
// claim window); the existing CSV import pipeline takes it from there. Any
// failure falls back to the classic TfL-12 steering harvest — this module is
// an optimisation, not a replacement.
//
// The fetches run from page context so the session cookie and the browser's
// TLS fingerprint ride along (TfL's WAF rejects non-browser clients — a
// native fetch would bounce). Script kept as ES5 source text (not a
// serialised function): Hermes' Function.prototype.toString returns
// "[bytecode]". The tests run this exact string against a stub DOM.

/** The statements page — where card ids live and where the script injects.
 * Duplicated from (not imported by) refresh-flow.NEW_STATEMENTS_URL so both
 * modules keep zero runtime imports and stay node-testable under
 * --experimental-strip-types — the test suite asserts the two match. */
export const NEW_STATEMENTS_URL = 'https://contactless.tfl.gov.uk/NewStatements';

/** The card list page (TfL-19) — links each active card's statements as
 * NewStatements/Billing?CardDisplayId=<32 hex>, making it the authoritative
 * same-origin source of the account's current card ids. */
export const MY_CARDS_URL = 'https://contactless.tfl.gov.uk/MyCards';

/** Whether a loaded URL is the statements page. */
export function isNewStatementsUrl(url: string): boolean {
  return /newstatements/i.test(url);
}

/**
 * Whether the direct CSV script should run on a loaded URL — picks which
 * script the refresh sheet injects (direct fetch here, classic harvest
 * elsewhere). TfL-17: the signed-in contactless Dashboard qualifies too —
 * TfL redirects every steer there, and the download endpoint is same-origin
 * from any contactless page, so the fetches work without ever reaching the
 * statements page.
 */
export function isDirectCsvUrl(url: string): boolean {
  return isNewStatementsUrl(url) || /contactless\.tfl\.gov\.uk\/dashboard/i.test(url);
}

/**
 * Card ids previously captured in the endpoint log (TfL-13's csvEndpointLog
 * meta entry, a JSON array of {source, url, at}). The Dashboard doesn't link
 * statements, so ids the log captured on earlier visits are the direct
 * fetch's best seed there. Corrupt or missing log → empty list, never throws.
 */
export function cardIdsFromLog(logJson: string | null): string[] {
  try {
    const entries = JSON.parse(logJson ?? '[]');
    if (!Array.isArray(entries)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const id = extractCardDisplayId(String(e?.url ?? ''));
      if (id && !seen.has(id.toLowerCase())) { seen.add(id.toLowerCase()); ids.push(id); }
    }
    return ids;
  } catch { return []; }
}

/**
 * Statement periods to fetch: current + previous month as TfL's
 * `<month>|<year>` tokens (month unpadded — the captured link used
 * `Period=5|2026` for May 2026). Accepts any `YYYY-MM...` prefix, so callers
 * can pass a local-time date string and stay off UTC month boundaries.
 */
export function currentAndPreviousPeriods(nowISO: string): string[] {
  const y = Number(nowISO.slice(0, 4));
  const m = Number(nowISO.slice(5, 7));
  const prev = m === 1 ? `12|${y - 1}` : `${m - 1}|${y}`;
  return [`${m}|${y}`, prev];
}

/** The journey-statement download endpoint for one card and period (TfL-19:
 * DownloadJourneyCsv, NOT DownloadBillingCsv — billing has no journey rows). */
export function buildCsvUrl(period: string, cardDisplayId: string): string {
  return `${NEW_STATEMENTS_URL}/DownloadJourneyCsv?Period=${encodeURIComponent(period)}&CardDisplayId=${encodeURIComponent(cardDisplayId)}`;
}

/** Whether a URL is a statement CSV download itself (either sibling endpoint)
 * — the capture WebView uses this to know a tapped link is worth importing. */
export function isCsvDownloadUrl(url: string): boolean {
  return /\/Download\w*Csv/i.test(String(url ?? ''));
}

/** Pull a CardDisplayId (32 hex chars) out of a statement link's href. */
export function extractCardDisplayId(href: string): string | null {
  const m = /CardDisplayId=([0-9a-fA-F]{32})/.exec(String(href ?? ''));
  return m ? m[1] : null;
}

/**
 * Cheap CSV-vs-HTML guard: a signed-out or errored response comes back as an
 * HTML page with a 200, not a statement. Requires the header row the existing
 * parser maps columns from (a data-less month still ships its header, which
 * imports as zero journeys — fine). Rejecting a real CSV only costs the
 * fallback steering harvest, so the guard errs strict.
 */
export function looksLikeCsv(text: string): boolean {
  const s = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (!s || s.charAt(0) === '<') return false;
  const line = s.split(/\r?\n/)[0] ?? '';
  return line.includes(',') && /date/i.test(line);
}

/** One fetched statement as the injected script reports it. */
export type DirectCsvFile = { text: string; card: string; period: string; url: string };

/** Most cards fetched in one refresh — mirrors refresh-flow.MAX_CARDS. */
export const MAX_DIRECT_CARDS = 8;

/**
 * Injected-JS direct fetch. Runs on the NewStatements page and posts exactly
 * one {type:'direct-csv', status, ...} message:
 *   status 'challenge'    — robot-check page; wait for the user to solve it
 *   status 'signed-out'   — login (or mid-login) page; user signs in here
 *   status 'wrong-page'   — not the statements page; fall back to steering
 *   status 'csv', files   — statements fetched: [{text, card, period, url}]
 *   status 'failed'       — no card ids found / nothing fetched; fall back
 *
 * Challenge and signed-out detection mirror the harvest script exactly — the
 * endpoint is behind the same login and the same WAF. Card ids are collected
 * from statement/download links (and any card <select>) on the page, then —
 * TfL-19, the primary source — the MyCards page is fetched same-origin and
 * mined for CardDisplayId links (every ACTIVE card on the account, nothing
 * hardcoded, exactly what an App Store install needs), then knownCards (the
 * endpoint log's previously captured ids) fill in, and as a last resort the
 * current page's raw HTML is mined (TfL-18 — the statements page is gone, so
 * the page we're standing on is the source). Every card × period pair is
 * fetched sequentially with the session cookie, HTML responses are dropped by
 * the same header check as looksLikeCsv, and one report carries whatever
 * survived. Nothing here throws into the page.
 */
export function buildDirectCsvScript(periods: string[], knownCards: string[] = []): string {
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var win = window;
    var periods = ${JSON.stringify(periods)};
    var known = ${JSON.stringify(knownCards)};
    var href = '';
    try { href = String((win.location && win.location.href) || '').toLowerCase(); } catch (e) { }

    // Robot check? Same DOM-based detection as the harvest script.
    var challenged = false;
    try {
      var title = String(doc.title || '').toLowerCase();
      if (/just a moment|attention required|verify you are human|are you a robot|security check/.test(title)) challenged = true;
      if (doc.querySelector('#challenge-form, #challenge-stage, #challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], [class*="cf-turnstile"]')) challenged = true;
    } catch (e) { }
    if (challenged) { report({ type: 'direct-csv', status: 'challenge' }); return; }

    // Login page? Same markers as the harvest script.
    var signedOut = false;
    try {
      if (doc.querySelector('input[type="password"]')) signedOut = true;
      if (href.indexOf('signin') !== -1 || href.indexOf('sign-in') !== -1
        || href.indexOf('login') !== -1) signedOut = true;
    } catch (e) { }
    if (signedOut) { report({ type: 'direct-csv', status: 'signed-out' }); return; }

    // TfL-17: any signed-in contactless page will do — the download endpoint
    // is same-origin from all of them (the Dashboard included, which is where
    // TfL redirects every steer). Off-domain pages (account.tfl.gov.uk) can't
    // reach it cross-origin, so those still fall back to steering.
    if (href.indexOf('contactless.tfl.gov.uk') === -1) {
      report({ type: 'direct-csv', status: 'wrong-page', href: href });
      return;
    }
    if (!win.fetch) {
      report({ type: 'direct-csv', status: 'failed', message: 'no fetch in page' });
      return;
    }

    // Card ids: statement/download links carry CardDisplayId=<32 hex>; a card
    // switcher <select> may hold bare ids as option values.
    var ids = [];
    var seen = {};
    var take = function (v) {
      var s = String(v || '');
      var m = /CardDisplayId=([0-9a-fA-F]{32})/.exec(s);
      var id = m ? m[1] : (/^[0-9a-fA-F]{32}$/.test(s) ? s : null);
      if (id && !seen[id.toLowerCase()]) { seen[id.toLowerCase()] = true; ids.push(id); }
    };
    try {
      var anchors = doc.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        take((anchors[i].getAttribute && anchors[i].getAttribute('href')) || anchors[i].href);
      }
      var options = doc.querySelectorAll('option');
      for (var o = 0; o < options.length; o++) { take(options[o].value); }
    } catch (e) { }
    // Collection finishes after the MyCards fetch below: knownCards (the
    // endpoint log's ids from earlier visits, TfL-17) fill in behind the live
    // sources, then — TfL-18 last resort — the current page's raw HTML is
    // mined; ids can sit in inline scripts or data attributes the
    // anchor/option sweep misses.
    var finishCollect = function () {
      for (var kc = 0; kc < known.length; kc++) { take(known[kc]); }
      if (!ids.length) {
        try {
          var html = String((doc.documentElement && doc.documentElement.innerHTML) || '');
          var hre = /CardDisplayId=([0-9a-fA-F]{32})/g;
          var hm;
          while ((hm = hre.exec(html))) { take(hm[1]); }
        } catch (e) { }
      }
      proceed();
    };

    // Same header check as looksLikeCsv — HTML 200s must not reach the parser.
    var isCsv = function (t) {
      var s = String(t || '').replace(/^\\uFEFF/, '').replace(/^\\s+/, '');
      if (!s || s.charAt(0) === '<') return false;
      var line = s.split(/\\r?\\n/)[0] || '';
      return line.indexOf(',') !== -1 && /date/i.test(line);
    };

    var proceed = function () {
      if (ids.length > ${MAX_DIRECT_CARDS}) { ids = ids.slice(0, ${MAX_DIRECT_CARDS}); }
      if (!ids.length) {
        report({ type: 'direct-csv', status: 'failed', message: 'no card ids on this page or in the endpoint log' });
        return;
      }
      var jobs = [];
      for (var c = 0; c < ids.length; c++) {
        for (var p = 0; p < periods.length; p++) { jobs.push({ card: ids[c], period: periods[p] }); }
      }
      var files = [];
      // Sequential, not parallel — kinder to the WAF, and order keeps the
      // report deterministic. A failed month is skipped, not fatal.
      var next = function (k) {
        if (k >= jobs.length) {
          if (files.length) { report({ type: 'direct-csv', status: 'csv', files: files }); }
          else { report({ type: 'direct-csv', status: 'failed', message: 'no statement CSV came back' }); }
          return;
        }
        var job = jobs[k];
        var url = '${NEW_STATEMENTS_URL}/DownloadJourneyCsv?Period='
          + encodeURIComponent(job.period) + '&CardDisplayId=' + encodeURIComponent(job.card);
        win.fetch(url, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.text();
          })
          .then(function (t) {
            if (isCsv(t)) { files.push({ text: t, card: job.card, period: job.period, url: url }); }
          })
          .catch(function () { })
          .then(function () { next(k + 1); });
      };
      next(0);
    };

    // TfL-19 primary source: the MyCards page links each ACTIVE card's
    // statements as NewStatements/Billing?CardDisplayId=<32 hex> — fetched
    // same-origin with the session cookie, so it works from the Dashboard
    // (which links no statements itself) and never needs a hardcoded id.
    // Page-sourced ids stay ahead of it in the list; a failed fetch just
    // falls through to knownCards / raw-HTML mining.
    win.fetch('${MY_CARDS_URL}', { credentials: 'include' })
      .then(function (res) { return res.ok ? res.text() : ''; })
      .then(function (html) {
        try {
          var re = /CardDisplayId=([0-9a-fA-F]{32})/g;
          var m;
          while ((m = re.exec(String(html || '')))) { take(m[1]); }
        } catch (e) { }
      })
      .catch(function () { })
      .then(function () { finishCollect(); });
  } catch (e) {
    report({ type: 'direct-csv', status: 'failed', message: String(e) });
  }
})(); true;`;
}
