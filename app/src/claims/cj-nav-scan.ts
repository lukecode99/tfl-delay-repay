// CorrectableJourneys nav scanner (TfL-OVERCHARGE-NAV). Pure module — node-testable.
//
// Builds the ES5 script injected into the CorrectableJourneys list page.
// The script scans for Apply-for-refund links, matches the target journey by
// date and origin station text, and navigates directly when exactly one confident
// match is found. On no-match or ambiguous results it reports back without
// navigating — the user selects manually. Never auto-submits anything.
//
// Script is ES5 (Hermes constraint): no arrow functions, no const/let, no
// template literals. All plan values are embedded via JSON.stringify.

export type CjNavPlan = {
  date: string;   // ISO YYYY-MM-DD — converted to "D Mon" for page text matching
  origin: string; // station name as it appears in StoredJourney
};

export type CjNavResult =
  | { type: 'cj-nav-result'; status: 'navigating'; href: string }
  | { type: 'cj-nav-result'; status: 'no-match' | 'ambiguous' | 'no-links' | 'error'; found?: number; matched?: number; message?: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Converts an ISO date string to the short label TfL uses in page text (e.g. "15 Jul"). */
export function dateToLabel(isoDate: string): string {
  const parts = isoDate.split('-');
  const day = parseInt(parts[2] ?? '0', 10) || 0;
  const mon = (parseInt(parts[1] ?? '1', 10) || 1) - 1;
  return day + ' ' + (MONTHS[mon] ?? '');
}

/** Builds the ES5 scanner script to inject into the CorrectableJourneys list page. */
export function buildCjNavScanScript(plan: CjNavPlan): string {
  const dateLabel = dateToLabel(plan.date).toLowerCase();
  const originNorm = plan.origin.toLowerCase();

  return `(function () {
  var report = function (msg) {
    try { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } } catch (e) { }
  };
  try {
    var dateLabel = ${JSON.stringify(dateLabel)};
    var originNorm = ${JSON.stringify(originNorm)};

    var links = [];
    var all = document.querySelectorAll ? document.querySelectorAll('a[href]') : [];
    for (var i = 0; i < all.length; i++) {
      var href = all[i].getAttribute ? String(all[i].getAttribute('href') || '') : '';
      if (/\\/ApplyForRefund/i.test(href)) { links.push(all[i]); }
    }

    if (links.length === 0) {
      report({ type: 'cj-nav-result', status: 'no-links' });
      return;
    }

    var normText = function (s) { return String(s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };

    // Walk up the DOM to the nearest row-like ancestor (TR, LI, or role=row/listitem).
    var rowOf = function (el) {
      var cur = el.parentElement || el.parentNode;
      for (var d = 0; d < 8 && cur; d++) {
        var tag = (cur.tagName || '').toUpperCase();
        if (tag === 'TR' || tag === 'LI') { return cur; }
        var role = cur.getAttribute ? (cur.getAttribute('role') || '').toLowerCase() : '';
        if (role === 'row' || role === 'listitem') { return cur; }
        cur = cur.parentElement || cur.parentNode;
      }
      return null;
    };

    var matched = [];
    for (var li = 0; li < links.length; li++) {
      var row = rowOf(links[li]) || links[li].parentElement || links[li];
      var rowText = normText(row.textContent);
      if (rowText.indexOf(dateLabel) >= 0 && rowText.indexOf(originNorm) >= 0) {
        matched.push(links[li]);
      }
    }

    if (matched.length === 1) {
      var dest = matched[0].getAttribute ? String(matched[0].getAttribute('href') || '') : '';
      // Resolve relative hrefs.
      if (dest && dest.charAt(0) === '/') { dest = window.location.protocol + '//' + window.location.host + dest; }
      report({ type: 'cj-nav-result', status: 'navigating', href: dest });
      if (dest) { window.location.href = dest; }
      return;
    }

    report({ type: 'cj-nav-result', status: matched.length === 0 ? 'no-match' : 'ambiguous', found: links.length, matched: matched.length });
  } catch (e) {
    report({ type: 'cj-nav-result', status: 'error', message: String(e) });
  }
})(); true;`;
}
