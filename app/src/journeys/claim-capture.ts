// Claim traffic capture (TfL-20). Pure module — node-testable.
//
// Next step after importing journeys is FILING the Delay Repay claims, and
// the claim endpoint + payload shape are unknown. Guessing endpoints burned
// three builds in TfL-17/19, so this module doesn't guess: it records. In
// capture (Manual) mode the injected script below instruments the page's
// outbound traffic — fetch, XMLHttpRequest and form submissions — and posts
// each request back to the app, where it lands in the persistent audit log.
// The user then walks through ONE genuine claim on the TfL site; the log
// afterwards holds the claim's endpoint, method, CSRF token field names and
// full payload — everything a later build needs to post claims directly.
//
// Scope and safety:
// - Only tfl.gov.uk requests (or relative URLs, which are same-origin) are
//   reported — third-party analytics noise never reaches the log.
// - Statement CSV downloads are skipped: the TfL-19 capture-fetch path
//   already audits those, and their bodies are journey data, not claim shape.
// - Values of password-ish fields (name or input type matching /pass/i) are
//   redacted before anything leaves the page.
// - Bodies are truncated to BODY_CAP chars so one giant response can't bloat
//   the meta-table ring buffer.
//
// Script kept as ES5 source text (not a serialised function): Hermes'
// Function.prototype.toString returns "[bytecode]". The tests run this exact
// string against a stub DOM. Zero runtime imports, same as direct-csv.

/** Longest request body the capture will report, in characters. */
export const BODY_CAP = 3000;

/** Whether a captured URL is worth reporting: TfL's own hosts (any
 * subdomain — claims may live on account./contactless./www.tfl.gov.uk) or a
 * relative URL, minus the statement CSV downloads TfL-19 already audits. */
export function isCaptureWorthy(url: string): boolean {
  const u = String(url ?? '');
  if (u === '') return false;
  if (/\/Download\w*Csv/i.test(u)) return false;
  if (/^https?:\/\//i.test(u)) return /^https?:\/\/[^/]*\btfl\.gov\.uk(?:[:/]|$)/i.test(u);
  return !/^(?:javascript|data|blob|about):/i.test(u); // relative → same-origin
}

/** One captured request, as posted back by the injected script. */
export type NetCapture = {
  type: 'net-capture';
  kind: 'fetch' | 'xhr' | 'form';
  method: string;
  url: string;
  body?: string;
  status?: number; // fetch only — posted in a second message once known
};

/** Render a capture as one audit-log detail line: method, URL, then the
 * body on its own line so the Log tab's share-as-text keeps it intact. */
export function describeCapture(msg: { kind?: unknown; method?: unknown; url?: unknown; body?: unknown; status?: unknown }): string {
  const head = `[${String(msg.kind ?? '?')}] ${String(msg.method ?? '?')} ${String(msg.url ?? '')}`
    + (typeof msg.status === 'number' ? ` → ${msg.status}` : '');
  const body = typeof msg.body === 'string' && msg.body !== '' ? msg.body.slice(0, BODY_CAP) : '';
  return body === '' ? head : `${head}\n${body}`;
}

/**
 * The injected interceptor. Installs once per page (navigation re-injects,
 * the window flag stops double-patching), then reports every worthy request:
 *
 * - fetch: method + URL + body posted synchronously BEFORE the real fetch —
 *   a claim POST often navigates away, and a message queued after would be
 *   lost with the page. The response status follows as a second message when
 *   (if) the promise resolves.
 * - XMLHttpRequest: open() stashes method/URL on the instance, send() posts
 *   them with the body.
 * - form submits: a capturing document listener serialises the form's named
 *   fields (hidden CSRF tokens included — those are the point) and posts
 *   action + method. Classic ASP.NET sites like TfL's post forms, not JSON.
 *
 * Every hook falls through to the original behaviour whatever happens — the
 * capture must never be able to break the user's real claim.
 */
export function buildNetCaptureScript(): string {
  return `(function () {
  try {
    var win = window;
    if (win.__tflNetCapture) { return; }
    win.__tflNetCapture = true;
    var CAP = ${BODY_CAP};
    var worthy = function (u) {
      u = String(u == null ? '' : u);
      if (u === '') { return false; }
      if (/\\/Download\\w*Csv/i.test(u)) { return false; }
      if (/^https?:\\/\\//i.test(u)) { return /^https?:\\/\\/[^/]*\\btfl\\.gov\\.uk(?:[:/]|$)/i.test(u); }
      return !/^(?:javascript|data|blob|about):/i.test(u);
    };
    var secret = function (name, type) {
      return /pass/i.test(String(name || '')) || /pass/i.test(String(type || ''));
    };
    var report = function (msg) {
      try {
        if (win.ReactNativeWebView) { win.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
      } catch (e) { }
    };
    var post = function (kind, method, url, body, status) {
      var msg = { type: 'net-capture', kind: kind, method: String(method || 'GET').toUpperCase(), url: String(url) };
      if (typeof body === 'string' && body !== '') { msg.body = body.slice(0, CAP); }
      if (typeof status === 'number') { msg.status = status; }
      report(msg);
    };
    var bodyText = function (b) {
      try {
        if (b == null) { return ''; }
        if (typeof b === 'string') { return b; }
        if (win.URLSearchParams && b instanceof win.URLSearchParams) { return b.toString(); }
        if (win.FormData && b instanceof win.FormData && b.forEach) {
          var parts = [];
          b.forEach(function (v, k) { parts.push(k + '=' + (secret(k) ? '[redacted]' : String(v))); });
          return parts.join('&');
        }
        return Object.prototype.toString.call(b);
      } catch (e) { return '[unreadable body]'; }
    };
    if (win.fetch) {
      var origFetch = win.fetch;
      win.fetch = function (input, init) {
        var method, url, body;
        try {
          url = input && input.url ? input.url : input;
          method = (init && init.method) || (input && input.method) || 'GET';
          body = bodyText(init && init.body);
          if (worthy(url)) { post('fetch', method, url, body); }
        } catch (e) { }
        var p = origFetch.apply(win, arguments);
        try {
          if (worthy(url) && p && p.then) {
            p.then(function (r) {
              try { post('fetch', method, url, '', r && r.status); } catch (e) { }
              return r;
            }, function () { });
          }
        } catch (e) { }
        return p;
      };
    }
    if (win.XMLHttpRequest && win.XMLHttpRequest.prototype && win.XMLHttpRequest.prototype.open) {
      var xp = win.XMLHttpRequest.prototype;
      var origOpen = xp.open;
      var origSend = xp.send;
      xp.open = function (method, url) {
        try { this.__cap = { method: method, url: url }; } catch (e) { }
        return origOpen.apply(this, arguments);
      };
      xp.send = function (body) {
        try {
          var c = this.__cap;
          if (c && worthy(c.url)) { post('xhr', c.method, c.url, bodyText(body)); }
        } catch (e) { }
        return origSend.apply(this, arguments);
      };
    }
    if (win.document && win.document.addEventListener) {
      win.document.addEventListener('submit', function (ev) {
        try {
          var form = ev && ev.target;
          if (!form || !form.elements) { return; }
          var action = form.action || (win.location && win.location.href) || '';
          if (!worthy(action)) { return; }
          var parts = [];
          for (var i = 0; i < form.elements.length; i++) {
            var el = form.elements[i];
            if (!el || !el.name) { continue; }
            parts.push(el.name + '=' + (secret(el.name, el.type) ? '[redacted]' : String(el.value == null ? '' : el.value)));
          }
          post('form', form.method || 'GET', action, parts.join('&'));
        } catch (e) { }
      }, true);
    }
  } catch (e) { }
})(); true;`;
}
