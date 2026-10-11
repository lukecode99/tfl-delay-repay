// TfL-26: claim-confirmation detector. Pure module — node-testable.
//
// After the user submits a service-delay-refund claim on tfl.gov.uk, TfL shows
// a confirmation page ("Thank you for your service delay refund application.
// We'll email you within 5 days…"). We read that page and, if it's the
// confirmation, post a message so the app can PROMPT the user to mark the claim
// submitted — reusing the existing "Mark claimed" mechanism. We never mark it
// automatically; the user confirms (Luke, 11-Oct-2026).
//
// Detection is text-based (not URL), because the confirmation copy is unique to
// the success page and survives TfL renaming the route. The Apply form itself
// contains "service delay refund" boilerplate, so we require the confirmation-
// only phrasing ("thank you for your service delay refund application" or
// "email you within N days") to avoid a false prompt mid-flow.
//
// Script is ES5 (Hermes/injected constraint): no arrow functions, no const/let,
// no template literals.

export type ClaimConfirmResult = { type: 'claim-confirmation' };

/** Normalises page text for matching: lowercase, collapse whitespace, strip apostrophes. */
export function normConfirmText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the given page text is the service-delay-refund confirmation page.
 * Matches the two confirmation-only signatures and rejects the Apply form's
 * generic "service delay refund" boilerplate.
 */
export function isClaimConfirmationText(text: string): boolean {
  const t = normConfirmText(text);
  if (!t) return false;
  // Primary: the confirmation heading.
  if (t.indexOf('thank you for your service delay refund application') >= 0) return true;
  // Secondary: the "we'll email you within N days" line only appears on success.
  if (/well email you within \d+ days?/.test(t)) return true;
  return false;
}

/** Builds the ES5 scanner injected into the claim WebView on each page load. */
export function buildClaimConfirmScanScript(): string {
  return `(function () {
  if (window.__tflClaimConfirmScan) { return; }
  var report = function () {
    try {
      var body = document.body ? String(document.body.innerText || document.body.textContent || '') : '';
      var t = body.toLowerCase().replace(/[’'\\\`]/g, '').replace(/\\s+/g, ' ');
      var hit = t.indexOf('thank you for your service delay refund application') >= 0
        || /well email you within \\d+ days?/.test(t);
      if (!hit) { return false; }
      window.__tflClaimConfirmScan = true;
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'claim-confirmation' })); }
      return true;
    } catch (e) { return false; }
  };
  // The confirmation text may land a beat after document-end; poll briefly.
  if (report()) { return; }
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (report() || tries > 8) { clearInterval(iv); }
  }, 300);
})(); true;`;
}
