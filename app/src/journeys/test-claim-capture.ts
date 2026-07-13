// Claim capture tests (TfL-20) — run with:
//   node --experimental-strip-types src/journeys/test-claim-capture.ts
// The script test executes the exact injected string against a stub DOM,
// same pattern as test-direct-csv.ts. No real endpoints or ids in here.
import assert from 'node:assert/strict';
import {
  BODY_CAP,
  buildNetCaptureScript,
  describeCapture,
  isCaptureWorthy,
  type NetCapture,
} from './claim-capture.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- isCaptureWorthy: TfL hosts + relative, minus CSV downloads/noise ---
ok(isCaptureWorthy('https://contactless.tfl.gov.uk/DelayRepay/Submit')
  && isCaptureWorthy('https://account.tfl.gov.uk/api/claim')
  && isCaptureWorthy('http://www.tfl.gov.uk/x'),
  'worthy: any tfl.gov.uk subdomain over http or https');
ok(isCaptureWorthy('/DelayRepay/Submit') && isCaptureWorthy('DelayRepay?x=1'),
  'worthy: relative URLs (same-origin) are kept');
ok(!isCaptureWorthy('https://www.google-analytics.com/collect')
  && !isCaptureWorthy('https://evil-tfl.gov.uk.attacker.com/x'),
  'worthy: third-party hosts and look-alike domains are dropped');
ok(isCaptureWorthy('https://sub.tfl.gov.uk/x') && !isCaptureWorthy('https://faketfl.gov.uk.co/x'),
  'worthy: boundary — real subdomain kept, spoofed suffix dropped');
ok(!isCaptureWorthy('https://contactless.tfl.gov.uk/NewStatements/DownloadJourneyCsv?Period=7|2026')
  && !isCaptureWorthy('https://contactless.tfl.gov.uk/NewStatements/DownloadBillingCsv?x=1'),
  'worthy: statement CSV downloads skipped (TfL-19 already audits those)');
ok(!isCaptureWorthy('') && !isCaptureWorthy('javascript:void(0)') && !isCaptureWorthy('data:text/html,x'),
  'worthy: empty, javascript: and data: URLs dropped');

// --- describeCapture: one-line head, body on its own line, truncation ---
ok(describeCapture({ kind: 'form', method: 'post', url: '/Submit', body: 'a=1&b=2' })
  === '[form] post /Submit\na=1&b=2',
  'describe: kind, method, url header then body on a second line');
ok(describeCapture({ kind: 'fetch', method: 'GET', url: '/x', status: 302 })
  === '[fetch] GET /x → 302',
  'describe: status appended when present, no body line when body empty');
ok(describeCapture({ url: '/x' }) === '[?] ? /x',
  'describe: missing kind/method fall back to ? and never throw');
ok(describeCapture({ kind: 'xhr', method: 'POST', url: '/x', body: 'z'.repeat(BODY_CAP + 500) }).length
  === `[xhr] POST /x\n`.length + BODY_CAP,
  'describe: body truncated to BODY_CAP');

// --- the injected interceptor, run against a stub DOM ---
type Msg = NetCapture;
function runScript(over: {
  fetch?: any;
  XMLHttpRequest?: any;
} = {}) {
  const posted: Msg[] = [];
  const submitListeners: Array<(ev: any) => void> = [];
  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    location: { href: 'https://contactless.tfl.gov.uk/DelayRepay' },
    URLSearchParams: class {}, // instanceof checks only
    FormData: class {},
    document: {
      addEventListener: (type: string, fn: any) => { if (type === 'submit') submitListeners.push(fn); },
    },
  };
  win.fetch = over.fetch;
  win.XMLHttpRequest = over.XMLHttpRequest;
  // The script references `window` free; execute with it bound.
  // eslint-disable-next-line no-new-func
  new Function('window', buildNetCaptureScript())(win);
  const fireSubmit = (form: any) => submitListeners.forEach(fn => fn({ target: form }));
  return { win, posted, fireSubmit };
}

// fetch: POST body reported before the call, status after it resolves
async function fetchOrderTest() {
  const calls: any[] = [];
  let resolveFetch: (v: any) => void = () => {};
  const fetchStub = (input: any, init: any) => { calls.push({ input, init }); return new Promise(r => { resolveFetch = r; }); };
  const { win, posted } = runScript({ fetch: fetchStub });
  const p = win.fetch('https://contactless.tfl.gov.uk/DelayRepay/Submit', { method: 'POST', body: 'claimDate=2026-07-01&fromStation=X' });
  ok(calls.length === 1 && posted.length === 1 && posted[0].kind === 'fetch'
    && posted[0].method === 'POST' && posted[0].body === 'claimDate=2026-07-01&fromStation=X'
    && posted[0].status === undefined,
    'fetch: method + URL + body posted synchronously, before the request resolves');
  resolveFetch({ status: 200 });
  await p;
  ok(posted.length === 2 && posted[1].status === 200 && (posted[1].body ?? '') === '',
    'fetch: a status-only message follows once the promise resolves');
}

async function main() {
  await fetchOrderTest();

  // fetch: third-party call is ignored entirely, real fetch still happens
  {
    const calls: any[] = [];
    const { win, posted } = runScript({ fetch: (i: any) => { calls.push(i); return Promise.resolve({ status: 204 }); } });
    win.fetch('https://www.google-analytics.com/collect', { method: 'POST', body: 'x' });
    ok(calls.length === 1 && posted.length === 0,
      'fetch: third-party request passes through untouched and is not reported');
  }

  // XHR: open stashes, send posts method+url+body
  {
    const opened: any[] = [];
    const sent: any[] = [];
    class XHR {
      open(method: string, url: string) { opened.push({ method, url }); }
      send(body: any) { sent.push(body); }
    }
    const { win, posted } = runScript({ XMLHttpRequest: XHR });
    const x = new win.XMLHttpRequest();
    x.open('POST', '/DelayRepay/Api');
    x.send('token=abc&amount=3.70');
    ok(opened.length === 1 && sent.length === 1 && posted.length === 1
      && posted[0].kind === 'xhr' && posted[0].method === 'POST'
      && posted[0].url === '/DelayRepay/Api' && posted[0].body === 'token=abc&amount=3.70',
      'xhr: open+send are wrapped, request reported with body, original still runs');
  }

  // form submit: named fields serialised, password redacted, CSRF kept
  {
    const { win, posted, fireSubmit } = runScript();
    const form = {
      action: 'https://contactless.tfl.gov.uk/DelayRepay/Submit',
      method: 'post',
      elements: [
        { name: '__RequestVerificationToken', type: 'hidden', value: 'CSRF123' },
        { name: 'JourneyDate', type: 'text', value: '2026-07-01' },
        { name: 'Password', type: 'password', value: 'hunter2' },
      ],
    };
    fireSubmit(form);
    ok(posted.length === 1 && posted[0].kind === 'form'
      && posted[0].url === 'https://contactless.tfl.gov.uk/DelayRepay/Submit'
      && posted[0].body === '__RequestVerificationToken=CSRF123&JourneyDate=2026-07-01&Password=[redacted]',
      'form: named fields serialised, CSRF token kept, password value redacted');
  }

  // form submit to a third-party action is ignored
  {
    const { posted, fireSubmit } = runScript();
    fireSubmit({ action: 'https://ads.example.com/x', method: 'post', elements: [{ name: 'a', value: '1' }] });
    ok(posted.length === 0, 'form: submit to a non-TfL action is not reported');
  }

  // programmatic form.submit() is captured even though it fires no submit event
  {
    const posted: Msg[] = [];
    let nativeSubmits = 0;
    class Form { submit() { nativeSubmits++; } }
    const win: any = {
      ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
      location: { href: 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund' },
      HTMLFormElement: Form,
      document: { addEventListener() {} },
    };
    new Function('window', buildNetCaptureScript())(win);
    const form: any = new win.HTMLFormElement();
    form.action = 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund';
    form.method = 'post';
    form.elements = [
      { name: '__RequestVerificationToken', type: 'hidden', value: 'CSRF9' },
      { name: 'DelayMinutes', type: 'text', value: '18' },
      { name: 'Password', type: 'password', value: 'nope' },
    ];
    form.submit();
    ok(nativeSubmits === 1 && posted.length === 1 && posted[0].kind === 'form'
      && posted[0].method === 'POST'
      && posted[0].body === '__RequestVerificationToken=CSRF9&DelayMinutes=18&Password=[redacted]',
      'form.submit(): programmatic submit captured (bypasses submit event) and still runs');
  }

  // navigator.sendBeacon to a TfL host is captured, original still called
  {
    const posted: Msg[] = [];
    let beaconArgs: any[] = [];
    const win: any = {
      ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
      location: { href: 'https://tfl.gov.uk/x' },
      navigator: { sendBeacon: (u: string, d: any) => { beaconArgs = [u, d]; return true; } },
      document: { addEventListener() {} },
    };
    new Function('window', buildNetCaptureScript())(win);
    const r = win.navigator.sendBeacon('https://tfl.gov.uk/DelayRepay/Beacon', 'a=1&b=2');
    ok(r === true && beaconArgs[0] === 'https://tfl.gov.uk/DelayRepay/Beacon'
      && posted.length === 1 && posted[0].kind === 'beacon' && posted[0].method === 'POST'
      && posted[0].body === 'a=1&b=2',
      'sendBeacon: TfL beacon captured, original still called and its return preserved');
  }

  // a third-party beacon is ignored (worthy filter), original still called
  {
    const posted: Msg[] = [];
    let called = false;
    const win: any = {
      ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
      location: { href: 'https://tfl.gov.uk/x' },
      navigator: { sendBeacon: () => { called = true; return true; } },
      document: { addEventListener() {} },
    };
    new Function('window', buildNetCaptureScript())(win);
    win.navigator.sendBeacon('https://analytics.example.com/b', 'x=1');
    ok(called && posted.length === 0, 'sendBeacon: third-party beacon passes through and is not reported');
  }

  // double injection is a no-op (window flag)
  {
    const posted: Msg[] = [];
    const win: any = { ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) }, document: { addEventListener() {} } };
    let n = 0;
    win.fetch = () => { n++; return Promise.resolve({ status: 200 }); };
    new Function('window', buildNetCaptureScript())(win);
    const patched = win.fetch;
    new Function('window', buildNetCaptureScript())(win);
    ok(win.fetch === patched, 'inject: second injection leaves the first patch in place (window flag)');
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
