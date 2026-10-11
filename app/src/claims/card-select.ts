// TfL-28: card-selection steer. Pure module — node-testable.
//
// The service-delay-refund Apply form (/ServiceDelayRefunds/Apply) is NOT
// reachable by a plain GET — not even with a ?cardDisplayId= query (TfL-27's
// wrong assumption). The classic contactless portal keeps the "selected card"
// in server-side session state, set by a POST /Card/SelectedCard. Loading Apply
// without a card selected returns TfL's generic "Sorry, there was a problem"
// error page (Luke, on-device, 11-Oct). The real flow we captured in July is:
//   Dashboard → MyCards → POST /Card/SelectedCard (cardDisplayId + CSRF) → Apply
// (project-notes/tfl-refund-app.md, TfL-20 capture). This module reproduces
// exactly what TfL's own MyCards page does when the user taps a card, so the
// Apply form then loads with the card in context.
//
// The injected script runs on the MyCards page: it reads the anti-forgery
// token from the page's hidden input and the 32-hex CardDisplayId (preferring
// the one we already mined from statement links, else scanning the page), POSTs
// the same-origin selection, then navigates to the Apply form. If it can't find
// a token or a card it stays put and reports back so the UI can fall back to the
// user tapping their card by hand — never worse than the old error page.
//
// Script is ES5 (Hermes/injected constraint): no arrow functions, no const/let,
// no template literals.

export const CONTACTLESS_MYCARDS_URL = 'https://contactless.tfl.gov.uk/MyCards';
export const CLAIM_APPLY_PATH = '/ServiceDelayRefunds/Apply';

/** True when the WebView is on the contactless MyCards list page. */
export function isMyCardsPage(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/MyCards(\/|$|[?#])/i.test(String(url || ''));
}

/** True when the WebView is on the post-login contactless Dashboard. */
export function isDashboardPage(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/Dashboard/i.test(String(url || ''));
}

/** A 32-hex CardDisplayId, or '' when the input isn't one (used to safely embed). */
function safeCardId(id: string | null | undefined): string {
  return /^[0-9a-fA-F]{32}$/.test(String(id || '')) ? String(id) : '';
}

/**
 * Builds the ES5 script injected into the MyCards page to select the card and
 * steer to the Apply form. `preferredId` is the CardDisplayId we already hold
 * (from statement links); when it isn't a valid 32-hex id the script scans the
 * page for one instead.
 */
export function buildCardSelectScript(preferredId?: string | null): string {
  const pref = safeCardId(preferredId);
  return `(function () {
  if (window.__tflCardSelect) { return; }
  var post = function (o) { try { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } } catch (e) {} };
  var preferred = ${JSON.stringify(pref)};
  var attempt = function () {
    try {
      if (!/MyCards/i.test(String(location.href))) { return false; }
      var tokEl = document.querySelector('input[name="__RequestVerificationToken"]');
      var tok = tokEl ? (tokEl.value || tokEl.getAttribute('value') || '') : '';
      var id = preferred;
      if (!/^[0-9a-fA-F]{32}$/.test(id)) {
        var html = document.documentElement ? (document.documentElement.innerHTML || '') : '';
        var m = /CardDisplayId=([0-9a-fA-F]{32})/i.exec(html);
        if (!m) { m = /\\/Card\\/([0-9a-fA-F]{32})/i.exec(html); }
        id = m ? m[1] : '';
      }
      if (!id || !tok) { return false; }
      window.__tflCardSelect = true;
      post({ type: 'card-select', ok: true, stage: 'posting' });
      var body = 'cardDisplayId=' + encodeURIComponent(id) + '&__RequestVerificationToken=' + encodeURIComponent(tok);
      fetch('/Card/SelectedCard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: body,
        credentials: 'include'
      }).then(function () {
        window.location.href = '${CLAIM_APPLY_PATH}';
      }, function (e) {
        post({ type: 'card-select', ok: false, reason: 'post-failed', error: String(e) });
      });
      return true;
    } catch (e) {
      post({ type: 'card-select', ok: false, reason: 'exception', error: String(e) });
      return true;
    }
  };
  if (attempt()) { return; }
  // The token/card may land a beat after the nav event; poll briefly.
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (attempt() || tries > 8) {
      clearInterval(iv);
      if (tries > 8 && !window.__tflCardSelect) { post({ type: 'card-select', ok: false, reason: 'timeout' }); }
    }
  }, 300);
})(); true;`;
}
