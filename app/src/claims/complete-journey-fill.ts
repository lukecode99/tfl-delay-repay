// "Complete my journey" wizard fill (TfL-OVERCHARGE-AUTO). Pure module — node-testable.
//
// Drives TfL's incomplete-journey correction wizard in the signed-in WebView.
// URL heuristics detect the wizard form page and the post-submit confirmation;
// an ES5 injected script fills the exit-station field when the form is found.
//
// Fill strategy (capture-first): buildNetCaptureScript records every form POST
// in the audit log when Luke manually walks through the wizard the first time.
// The selectors below cover the most likely field names; the schema dump in
// every fill result lets us refine them from real captures without a new build.
//
// Graceful fallback: if no matching field is found (filled=0) the screen falls
// back to the copy-chip manual flow — no unattended submission ever happens.
//
// Script is ES5 source text (Hermes constraint). Stub-DOM tested in
// test-complete-journey-fill.ts.

/** Data the fill script needs from the app's own records. */
export interface CompleteJourneyPlan {
  /** Inferred exit station, from OverchargeCandidate.likelyDestination. */
  exitStation: string;
}

const TFL_CONTACTLESS = /contactless\.tfl\.gov\.uk/i;

/**
 * True when `url` looks like TfL's "Complete my journey" form page.
 * Liberal — prefers false positives (re-injecting harmlessly) over misses.
 */
export function isCompleteJourneyFormPage(url: string): boolean {
  if (!TFL_CONTACTLESS.test(url)) return false;
  // "complete my journey" phrasing — the word "my" is absent from list-page URLs
  if (/complete.{0,4}my.{0,4}journey/i.test(url)) return true;
  // Path segments: /IncompleteJourney/… or /CompleteJourney (singular, not plural list)
  // (?!s) excludes /IncompleteJourneys which is the list page, not the form
  if (/\/(?:in)?complete.{0,4}journey(?!s)/i.test(url)) return true;
  // /CorrectJourney — TfL's alternate phrasing for fare correction
  if (/\/correct.{0,4}journey/i.test(url)) return true;
  return false;
}

/**
 * True when `url` looks like TfL's post-submit confirmation page — the cue to
 * show the "Review and submit" banner.
 */
export function isCompleteJourneyConfirmPage(url: string): boolean {
  if (!TFL_CONTACTLESS.test(url)) return false;
  return /confirm|success|thank/i.test(url);
}

/**
 * URL for a card's incomplete-journeys section on contactless.tfl.gov.uk.
 * Inferred from TfL's common path pattern; confirmed by first manual capture.
 */
export function incompleteJourneysUrl(cardDisplayId: string): string {
  return `https://contactless.tfl.gov.uk/MyCards/${encodeURIComponent(cardDisplayId)}/IncompleteJourneys`;
}

/**
 * Build the injected ES5 fill script. Tries a ranked list of selectors for
 * TfL's exit-station control, then falls back to label-text search. Always
 * emits a schema dump so one real run gives full diagnostics for later tuning.
 *
 * Reports: `{type:'complete-journey-fill', filled, total:1, results, schema}`.
 * Same envelope as apply-fill so callers handle both uniformly.
 */
export function buildCompleteJourneyFillScript(plan: CompleteJourneyPlan): string {
  const payload = JSON.stringify(plan);
  return `(function () {
  var report = function (msg) {
    try { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } } catch (e) { }
  };
  try {
    var plan = ${payload};
    var doc = document;
    var win = window;
    var results = [];
    var filled = 0;

    var setNativeValue = function (el, value) {
      try {
        var proto = (el.tagName === 'SELECT' && win.HTMLSelectElement) ? win.HTMLSelectElement.prototype
          : (el.tagName === 'TEXTAREA' && win.HTMLTextAreaElement) ? win.HTMLTextAreaElement.prototype
          : (win.HTMLInputElement) ? win.HTMLInputElement.prototype : null;
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(el, value); return; }
      } catch (e) { }
      try { el.value = value; } catch (e2) { }
    };
    var fire = function (el) {
      try { el.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new win.Event('change', { bubbles: true })); } catch (e) { }
      try { if (win.jQuery) { win.jQuery(el).trigger('change'); } } catch (e) { }
    };
    var q = function (sel) { try { return doc.querySelector(sel); } catch (e) { return null; } };
    var normText = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/\\s+/g, ' ').trim(); };

    // Ranked selectors: exact captured POST names first (mirroring Apply form
    // conventions from TfL-20/21), then plausible guesses. Update with real
    // field names once the first manual capture lands in the audit log.
    var STATION_SELECTORS = [
      '[name="FinishNlcId"]',
      '[name="ExitStationId"]',
      '[name="FinishStation"]',
      '[name="ExitStation"]',
      '[name="DestinationNlcId"]',
      '[name="DestinationStation"]',
      '[name="stationId"]',
      '[name="station"]',
    ];

    var stationEl = null;
    for (var s = 0; s < STATION_SELECTORS.length; s++) {
      var c = q(STATION_SELECTORS[s]);
      if (c) { stationEl = c; break; }
    }

    // Label-text fallback: find an input whose <label> contains exit/destination
    // keywords. Covers TfL restyling the field names while keeping label copy.
    if (!stationEl) {
      try {
        var LABEL_RE = /exit|destination|tap.{0,4}out|touch.{0,4}out|finish|end station/i;
        var labels = doc.querySelectorAll ? doc.querySelectorAll('label') : [];
        for (var l = 0; l < labels.length; l++) {
          if (LABEL_RE.test(labels[l].textContent || '')) {
            var forId = labels[l].htmlFor || (labels[l].getAttribute && labels[l].getAttribute('for'));
            if (forId) {
              var t = doc.getElementById ? doc.getElementById(forId) : null;
              if (t && (t.type || '').toLowerCase() !== 'hidden') { stationEl = t; break; }
            }
          }
        }
      } catch (e) { }
    }

    if (stationEl) {
      if (stationEl.tagName === 'SELECT') {
        // Match option text to the station name (case-insensitive, prefix-tolerant
        // so "Northolt" matches "Northolt [Zone 5]" and vice-versa).
        var exitNorm = normText(plan.exitStation);
        var opts = stationEl.options || [];
        var matched = null;
        for (var o = 0; o < opts.length; o++) {
          var optNorm = normText(opts[o].textContent || opts[o].text || '');
          if (optNorm === exitNorm || optNorm.indexOf(exitNorm) === 0 || exitNorm.indexOf(optNorm) === 0) {
            matched = opts[o]; break;
          }
        }
        if (matched) {
          setNativeValue(stationEl, matched.value);
          try { stationEl.selectedIndex = Array.prototype.indexOf.call(stationEl.options, matched); } catch (e) { }
          try { matched.selected = true; } catch (e) { }
          fire(stationEl);
          results.push({ field: 'exitStation', filled: true, via: 'select', value: matched.value });
          filled++;
        } else {
          results.push({ field: 'exitStation', filled: false, via: 'no-option', tried: plan.exitStation });
        }
      } else {
        // Text / typeahead input: set the visible name. Hidden NLC fields
        // (if any) are not set here — the first manual capture will confirm
        // whether a hidden-NLC pattern applies (same as Apply form TfL-21).
        setNativeValue(stationEl, plan.exitStation);
        fire(stationEl);
        results.push({ field: 'exitStation', filled: true, via: stationEl.tagName === 'INPUT' ? 'input' : stationEl.tagName, name: stationEl.name || stationEl.id || '' });
        filled++;
      }
    } else {
      results.push({ field: 'exitStation', filled: false, via: 'not-found' });
    }

    // Schema dump: all named controls on the page for diagnostics (capped at 60).
    // Always emitted so every run contributes to understanding the form shape.
    var schema = [];
    try {
      var formEl = q('form') || doc;
      var controls = formEl.querySelectorAll ? formEl.querySelectorAll('input[name], select[name], textarea[name], button[name]') : [];
      for (var ci = 0; ci < controls.length && ci < 60; ci++) {
        var ce = controls[ci];
        var row = { name: ce.name || '', tag: ce.tagName, type: (ce.type || '').toLowerCase(), id: ce.id || '' };
        if (ce.tagName === 'SELECT' && ce.options) {
          var sopts = [];
          for (var so = 0; so < ce.options.length && so < 20; so++) {
            sopts.push({ v: ce.options[so].value, t: normText(ce.options[so].textContent || '').slice(0, 30) });
          }
          row.options = sopts;
        }
        schema.push(row);
      }
    } catch (e) { }

    report({ type: 'complete-journey-fill', filled: filled, total: 1, results: results, schema: schema });
  } catch (e) {
    report({ type: 'complete-journey-fill', error: String(e) });
  }
})(); true;`;
}
