// TfL-28: card-selection steer. Pure module — node-testable.
//
// The service-delay-refund Apply form (/ServiceDelayRefunds/Apply) needs BOTH:
//   (1) the card selected server-side via POST /Card/SelectedCard (cardDisplayId
//       + CSRF), and
//   (2) the SAME card id passed on the Apply URL as ?cardDisplayId=<id>.
// A bare /Apply (no query) bounces back to MyCards even after a 200 select;
// a ?cardDisplayId= with no prior select hits the "Sorry, there was a problem"
// page. TfL's own per-card link on MyCards is exactly
//   /ServiceDelayRefunds/Apply?cardDisplayId=<id>
// and the tap first fires an xhr POST /Card/SelectedCard. Confirmed end-to-end
// from Luke's manual run (22-Oct build-83 trace): select → 200, navigate to
// /Apply?cardDisplayId=<id> → the Apply form loads and autofills.
// The real flow:
//   Dashboard → MyCards → POST /Card/SelectedCard → Apply?cardDisplayId=<id>
// This module reproduces exactly what TfL's own MyCards tap does.
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

/**
 * Meta-table key for the card the user last tapped by hand. TfL-32: when the
 * account has several registered cards we can't safely guess which one is
 * theirs, so the app learns it from the user's genuine manual tap (the xhr
 * POST /Card/SelectedCard) and reuses it next time — survives card
 * re-tokenisation and needs no hardcoded id in this (public) repo.
 */
export const PREFERRED_CARD_KEY = 'tflPreferredCardId';

/** Pull a 32-hex cardDisplayId from a SelectedCard POST body, or '' if absent. */
export function cardIdFromSelectBody(body: string | null | undefined): string {
  const m = /cardDisplayId=([0-9a-fA-F]{32})/i.exec(String(body || ''));
  return m ? m[1] : '';
}

/**
 * Trim a navigation URL for the audit log. The Azure B2C sign-in step carries a
 * giant id_token_hint JWT + nonce in its query string (TfL-32, Luke 22-Oct:
 * floods the Log tab and eats the share buffer) with zero diagnostic value — so
 * for the sign-in/OAuth hosts keep just the path. Everything else keeps its
 * query: we rely on seeing ?cardDisplayId= on the Apply URL.
 */
export function tidyNavLogUrl(url: string): string {
  const u = String(url || '');
  if (!/account\.tfl\.gov\.uk|signin-oidc/i.test(u)) return u;
  const q = u.indexOf('?');
  return q >= 0 ? u.slice(0, q) + '?…' : u;
}

/** True when the WebView is on the contactless MyCards list page. */
export function isMyCardsPage(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/MyCards(\/|$|[?#])/i.test(String(url || ''));
}

/** True when the WebView is on the post-login contactless Dashboard. */
export function isDashboardPage(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/Dashboard/i.test(String(url || ''));
}

/**
 * True when the URL is a sign-in / session-timeout bounce rather than a real
 * contactless content page — the TfL B2C OAuth host, the signin-oidc callback,
 * or the /HomePage/Login(TimedOut) stubs.
 *
 * TfL-29 (Luke, 11-Oct evening): opening the claim with a timed-out session hits
 * /MyCards for a split second before it 302s to /HomePage/LoginTimedOut → OAuth.
 * That transient MyCards would burn the claim screen's one-shot card-selection
 * guard, so the steer never fired on the *real* MyCards after login and the user
 * was stranded on the card list. The claim screen resets its one-shot guards on
 * any URL this matches, so the Dashboard→MyCards→SelectedCard steer runs fresh
 * once sign-in completes.
 */
export function isLoginRedirectUrl(url: string): boolean {
  var u = String(url || '');
  return /account\.tfl\.gov\.uk/i.test(u)
    || /signin-oidc/i.test(u)
    || /\/HomePage\/LoginTimedOut/i.test(u)
    || /\/HomePage\/Login(\/|$|[?#])/i.test(u);
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
  // TfL-28 DIAG (12-Oct): on a warm session the steer posted nothing back —
  // no 'posting', no 'timeout'. One unconditional probe so the log shows
  // whether the script ran at all and what the real MyCards DOM exposes (token
  // input, scannable 32-hex id, link/button/form counts). Guides the real fix.
  if (/MyCards/i.test(String(location.href))) {
    try {
      var dTok = document.querySelector('input[name="__RequestVerificationToken"]');
      var dHtml = document.documentElement ? (document.documentElement.innerHTML || '') : '';
      var dM = /CardDisplayId=([0-9a-fA-F]{32})/i.exec(dHtml);
      if (!dM) { dM = /\\/Card\\/([0-9a-fA-F]{32})/i.exec(dHtml); }
      // TfL-31 (build-82 trace, 22-Oct): POST /Card/SelectedCard 404s, so the
      // July endpoint is stale. Dump the page's real form actions + card/apply
      // links so the next build can hit the mechanism TfL's own tap uses.
      var dForms = [];
      var dLinks = [];
      if (document.querySelectorAll) {
        var fEls = document.querySelectorAll('form');
        for (var fi = 0; fi < fEls.length && fi < 20; fi++) {
          dForms.push(((fEls[fi].getAttribute('method') || 'get') + ' ' + (fEls[fi].getAttribute('action') || '')).slice(0, 120));
        }
        var aEls = document.querySelectorAll('a');
        for (var ai = 0; ai < aEls.length && dLinks.length < 12; ai++) {
          var hr = aEls[ai].getAttribute('href') || '';
          if (/Card|Apply|Select|Refund/i.test(hr)) { dLinks.push(hr.slice(0, 120)); }
        }
      }
      post({
        type: 'card-diag',
        href: String(location.href),
        hasToken: !!dTok,
        prefOk: /^[0-9a-fA-F]{32}$/.test(preferred),
        prefInDom: /^[0-9a-fA-F]{32}$/.test(preferred) && dHtml.indexOf(preferred) >= 0,
        scannedId: dM ? dM[1] : '',
        formActions: dForms,
        cardLinks: dLinks,
        anchors: document.querySelectorAll ? document.querySelectorAll('a').length : -1,
        buttons: document.querySelectorAll ? document.querySelectorAll('button').length : -1,
        forms: document.querySelectorAll ? document.querySelectorAll('form').length : -1
      });
    } catch (de) { post({ type: 'card-diag', error: String(de) }); }
  }
  var attempt = function () {
    try {
      if (!/MyCards/i.test(String(location.href))) { return false; }
      var tokEl = document.querySelector('input[name="__RequestVerificationToken"]');
      var tok = tokEl ? (tokEl.value || tokEl.getAttribute('value') || '') : '';
      if (!tok) { return false; }
      var html = document.documentElement ? (document.documentElement.innerHTML || '') : '';
      // TfL-33 (Luke 23-Oct): the account can hold many cards (he has 6), but the
      // MyCards page tags each one "Ready for travel" vs "Card has expired" /
      // "Unable to travel". Classify every card by its own block's status so we
      // can skip the dead cards and auto-pick the single travel-ready one — no tap.
      var blockText = function (el) {
        // Climb to the smallest ancestor that holds exactly one "Reference number"
        // label: that is this card's own block, isolated from its siblings.
        var node = el;
        for (var up = 0; up < 12 && node && node.parentNode; up++) {
          node = node.parentNode;
          var t = node.textContent || '';
          if (/Reference number/i.test(t)) {
            var c = t.match(/Reference number/ig);
            return (c && c.length === 1) ? t : '';
          }
        }
        return '';
      };
      var statusOf = function (t) {
        if (!t) { return 'unknown'; }
        if (/unable to travel|card has expired/i.test(t)) { return 'expired'; }
        if (/ready for travel/i.test(t)) { return 'active'; }
        return 'unknown';
      };
      // Walk the card links, dedup by id, and tag each with its block status.
      var ids = [];
      var status = {};
      var seen = {};
      var anchors = document.querySelectorAll ? document.querySelectorAll('a') : [];
      for (var ai = 0; ai < anchors.length; ai++) {
        var hr = anchors[ai].getAttribute('href') || '';
        var hm = /(?:cardDisplayId=|\\/Card\\/)([0-9a-fA-F]{32})/i.exec(hr);
        if (!hm) { continue; }
        var aid = hm[1];
        var akey = aid.toLowerCase();
        if (seen[akey]) { continue; }
        seen[akey] = true;
        ids.push(aid);
        status[akey] = statusOf(blockText(anchors[ai]));
      }
      // Fallback for an unexpected DOM (no anchors): scan the raw HTML, status unknown.
      if (ids.length === 0) {
        var re = /(?:cardDisplayId=|\\/Card\\/)([0-9a-fA-F]{32})/ig;
        var mm;
        while ((mm = re.exec(html)) !== null) {
          var cid = mm[1].toLowerCase();
          if (!seen[cid]) { seen[cid] = true; ids.push(mm[1]); status[cid] = 'unknown'; }
        }
      }
      var active = [];
      for (var ii = 0; ii < ids.length; ii++) {
        if (status[ids[ii].toLowerCase()] === 'active') { active.push(ids[ii]); }
      }
      // Pick, in order: a card we learned from a manual tap (if still listed) wins;
      // else the single travel-ready card; else the sole card. With several viable
      // cards and no learned match we must NOT guess — filing against the wrong
      // card is worse than one tap (TfL's own per-card Apply link works).
      var id = '';
      if (/^[0-9a-fA-F]{32}$/.test(preferred) && html.indexOf(preferred) >= 0) {
        id = preferred;
      } else if (active.length === 1) {
        id = active[0];
      } else if (ids.length === 1) {
        id = ids[0];
      } else {
        window.__tflCardSelect = true;
        post({ type: 'card-select', ok: false, reason: 'ambiguous-cards', count: ids.length, active: active.length });
        return true;
      }
      if (!id) { return false; }
      window.__tflCardSelect = true;
      post({ type: 'card-select', ok: true, stage: 'posting' });
      var body = 'cardDisplayId=' + encodeURIComponent(id) + '&__RequestVerificationToken=' + encodeURIComponent(tok);
      fetch('/Card/SelectedCard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: body,
        credentials: 'include'
      }).then(function (res) {
        if (res && (res.ok || res.status === 200)) {
          post({ type: 'card-select', ok: true, stage: 'selected' });
          // TfL-31: the Apply page keys off the cardDisplayId *query param* — the
          // page's own card link is /ServiceDelayRefunds/Apply?cardDisplayId=<id>,
          // and a bare /Apply bounced back to MyCards even after a 200 select
          // (Luke 22-Oct). Replicate the page's link exactly.
          window.location.href = '${CLAIM_APPLY_PATH}?cardDisplayId=' + encodeURIComponent(id);
        } else {
          // Don't bounce through a card-less Apply on a 404 — stay on MyCards so
          // a manual tap lets net-capture record TfL's real select endpoint.
          window.__tflCardSelect = false;
          post({ type: 'card-select', ok: false, reason: 'select-http', status: res ? res.status : 0 });
        }
      }, function (e) {
        window.__tflCardSelect = false;
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
