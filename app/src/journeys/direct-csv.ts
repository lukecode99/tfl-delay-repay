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
 * How many months of statements a deep refresh pulls (TfL-22). Twelve months
 * gives the incomplete-fare detector enough history to learn each origin's
 * regular route AND surfaces older missing tap-outs the user was overcharged
 * for — not just the last few weeks. TfL's DownloadJourneyCsv serves any past
 * month from the same endpoint, so this is just more Period tokens.
 */
export const HISTORY_MONTHS = 12;

/**
 * Meta key written after the first successful deep pull. Subsequent refreshes
 * check for its presence: absent → 12-month deep pull; present → 2-month
 * routine pull (current + previous month only).
 */
export const DEEP_PULL_META_KEY = 'deep-pull-done-v1';

/** Periods fetched per refresh pass (backfill and routine). Capped at 2 so
 * job count (cards × periods × 2) stays ≤ 32 and completes well within the
 * scaled harvest timeout even on a 6-card account. */
export const PASS_PERIODS = 2;

/** Budget per sequential fetch for harvest-timer scaling. */
export const PER_JOB_MS = 2_500;

/**
 * Per-mode deep-pull completion key. Contactless reuses the original key for
 * backwards compat with existing installs; Oyster and Both get distinct keys
 * so switching mode always triggers a fresh deep pull for the new mode.
 * Oyster history is capped at ~8 weeks by TfL, so its deep pull is cheap.
 */
export function deepPullMetaKeyFor(mode: 'contactless' | 'oyster' | 'both'): string {
  return mode === 'contactless' ? DEEP_PULL_META_KEY : `${DEEP_PULL_META_KEY}-${mode}`;
}

/**
 * Statement periods to fetch for this refresh. Always includes the routine
 * PASS_PERIODS window (current + previous month) so recent journeys are never
 * starved during backfill. When the deep pull is incomplete, also appends up
 * to PASS_PERIODS uncovered months from the history window (slice(2) — the
 * months beyond the routine window), giving up to 2×PASS_PERIODS periods
 * total per pass. Coverage accumulates across passes until complete.
 */
export function periodsForRefresh(nowISO: string, meta: string | null): string[] {
  const routineWindow = lastNPeriods(nowISO, PASS_PERIODS);
  if (isDeepPullComplete(meta, nowISO)) return routineWindow;
  const covered = deepPullCoveredPeriods(meta);
  const uncoveredHistory = lastNPeriods(nowISO, HISTORY_MONTHS).slice(2).filter(p => !covered.has(p));
  return [...routineWindow, ...uncoveredHistory.slice(0, PASS_PERIODS)];
}

/**
 * Count of periods in the HISTORY_MONTHS window that still need to be proven.
 * Zero means the deep pull is complete. Exposed for the UI's backfill status
 * line — shows the user progress without blocking them.
 */
export function pendingDeepPullPeriods(nowISO: string, meta: string | null): number {
  if (isDeepPullComplete(meta, nowISO)) return 0;
  const covered = deepPullCoveredPeriods(meta);
  return lastNPeriods(nowISO, HISTORY_MONTHS).slice(2).filter(p => !covered.has(p)).length;
}

/**
 * Parse the stored deep-pull marker. Returns the set of proven period tokens
 * (e.g. '7|2026'). Null and the legacy 'done' string are treated as empty —
 * unproven, so existing installs re-pull once to establish period-level proof.
 */
export function deepPullCoveredPeriods(meta: string | null): Set<string> {
  if (!meta || meta === 'done') return new Set();
  try {
    const arr = JSON.parse(meta);
    return new Set(Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string') : []);
  } catch { return new Set(); }
}

/**
 * True only when the stored marker proves every period in the HISTORY_MONTHS
 * window for nowISO. Legacy 'done' is never considered complete.
 */
export function isDeepPullComplete(meta: string | null, nowISO: string): boolean {
  const covered = deepPullCoveredPeriods(meta);
  // Exclude the routine 2-month window (current + previous month) from the
  // completeness check. Routine pulls always cover those two, so requiring them
  // proven would force a 12-month re-pull on every calendar month rollover.
  return lastNPeriods(nowISO, HISTORY_MONTHS).slice(2).every(p => covered.has(p));
}

/**
 * Returns a new marker value that merges newPeriods into the existing coverage
 * set. Periods are sorted newest-first for readability in the DB.
 */
export function mergeDeepPullCoverage(existing: string | null, newPeriods: readonly string[]): string {
  const merged = new Set([...deepPullCoveredPeriods(existing), ...newPeriods]);
  return JSON.stringify(
    [...merged].sort((a, b) => {
      const [am, ay] = a.split('|').map(Number);
      const [bm, by] = b.split('|').map(Number);
      return ay !== by ? by - ay : bm - am;
    }),
  );
}

/**
 * The last `months` statement periods as TfL's `<month>|<year>` tokens
 * (month unpadded — the captured link used `Period=5|2026` for May 2026),
 * newest first. Accepts any `YYYY-MM...` prefix so callers can pass a
 * local-time date string and stay off UTC month boundaries. Walks the
 * calendar backwards so year boundaries are handled for any depth.
 */
export function lastNPeriods(nowISO: string, months: number): string[] {
  let y = Number(nowISO.slice(0, 4));
  let m = Number(nowISO.slice(5, 7));
  const out: string[] = [];
  for (let k = 0; k < Math.max(1, months); k++) {
    out.push(`${m}|${y}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

/**
 * Statement periods to fetch: current + previous month. Retained as the
 * shallow default (and for callers that only need the Delay Repay claim
 * window); deep history uses lastNPeriods(nowISO, HISTORY_MONTHS).
 */
export function currentAndPreviousPeriods(nowISO: string): string[] {
  return lastNPeriods(nowISO, 2);
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
export function buildDirectCsvScript(periods: string[], knownCards: string[] = [], billingPeriods: string[] = []): string {
  const resolvedBillingPeriods = billingPeriods.length ? billingPeriods : periods.slice(0, 2);
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var win = window;
    var periods = ${JSON.stringify(periods)};
    var billingPeriods = ${JSON.stringify(resolvedBillingPeriods)};
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

    // Journey CSV guard: requires both "date" AND "journey" in the header so
    // billing CSVs (Date column, no Journey column) are excluded.
    var isJourneyCsvGuard = function (t) {
      var s = String(t || '').replace(/^\\uFEFF/, '').replace(/^\\s+/, '');
      if (!s || s.charAt(0) === '<') return false;
      var line = (s.split(/\\r?\\n/)[0] || '').toLowerCase();
      return line.indexOf(',') !== -1 && line.indexOf('date') !== -1 && line.indexOf('journey') !== -1;
    };
    // Billing CSV guard: only requires "date" (billing has no Journey column).
    var isBillingCsvGuard = function (t) {
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
      var journeyReported = false;
      // Sequential, not parallel — kinder to the WAF, and order keeps the
      // report deterministic. A failed month is skipped, not fatal.
      var next = function (k) {
        if (k >= jobs.length) {
          // Journey pass done. Report immediately so a billing-pass timeout
          // cannot cost us the already-fetched journey data.
          if (files.length) {
            report({ type: 'direct-csv', status: 'csv', files: files, billingFiles: [] });
            journeyReported = true;
          }
          // Billing CSV pass (non-fatal — refund credit data only). Restricted
          // to the routine window (billingPeriods) so a close-before-finish
          // cannot drop history-pass journey data already banked above.
          var billingJobs = [];
          for (var bc = 0; bc < ids.length; bc++) {
            for (var bp = 0; bp < billingPeriods.length; bp++) { billingJobs.push({ card: ids[bc], period: billingPeriods[bp] }); }
          }
          var billingFiles = [];
          var billingNext = function (bk) {
            if (bk >= billingJobs.length) {
              if (billingFiles.length) {
                report({ type: 'direct-csv', status: 'billing', billingFiles: billingFiles });
              } else if (!journeyReported) {
                report({ type: 'direct-csv', status: 'failed', message: 'no statement CSV came back' });
              }
              return;
            }
            var bjob = billingJobs[bk];
            var burl = '${NEW_STATEMENTS_URL}/DownloadBillingCsv?Period='
              + encodeURIComponent(bjob.period) + '&CardDisplayId=' + encodeURIComponent(bjob.card);
            win.fetch(burl, { credentials: 'include' })
              .then(function (res) { return res.ok ? res.text() : ''; })
              .then(function (t) { if (isBillingCsvGuard(t)) { billingFiles.push({ text: t, card: bjob.card, period: bjob.period, url: burl }); } })
              .catch(function () { })
              .then(function () { billingNext(bk + 1); });
          };
          billingNext(0);
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
            if (isJourneyCsvGuard(t)) { files.push({ text: t, card: job.card, period: job.period, url: url }); }
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
