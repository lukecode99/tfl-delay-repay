// claim-confirmation detector tests — run with:
//   node --experimental-strip-types src/claims/test-claim-confirm-scan.ts
import assert from 'node:assert/strict';
import { buildClaimConfirmScanScript, isClaimConfirmationText, normConfirmText } from './claim-confirm-scan.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// ── isClaimConfirmationText ────────────────────────────────────────────────────

ok(isClaimConfirmationText('Thank you for your service delay refund application. We will email you within 5 days.'),
  'confirmation heading → true');
ok(isClaimConfirmationText("Thank you for your service delay refund application. We'll email you within 5 days."),
  'confirmation with curly/straight apostrophe → true');
ok(isClaimConfirmationText("We'll email you within 5 days to let you know the outcome."),
  'secondary "email you within 5 days" line alone → true');
ok(isClaimConfirmationText("We'll email you within 10 days"),
  'secondary line with a different day count → true');

// Apply-form / boilerplate text must NOT trip the detector
ok(!isClaimConfirmationText('You can only claim a service delay refund if your journey was delayed for 15 minutes or more.'),
  'Apply-form boilerplate mentioning "service delay refund" → false');
ok(!isClaimConfirmationText('Apply for a service delay refund'),
  'Apply heading → false');
ok(!isClaimConfirmationText('Sorry, there was a problem'),
  'TfL error page → false');
ok(!isClaimConfirmationText(''), 'empty text → false');

// ── normConfirmText ────────────────────────────────────────────────────────────

ok(normConfirmText('  Thank   You\n\tFOR ') === 'thank you for', 'normalises case + whitespace');
ok(normConfirmText("we'll") === 'well', 'strips apostrophes');

// ── Injected script behaviour (ES5, run via new Function) ───────────────────────

function runScan(bodyText: string): any[] {
  const posted: any[] = [];
  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
  };
  const doc: any = { body: { innerText: bodyText, textContent: bodyText } };
  // setInterval/clearInterval stubs: the first synchronous report() call should
  // already fire on a confirmation page, so the timer never needs to tick here.
  const setInterval = (_: any) => 1;
  const clearInterval = (_: any) => {};
  new Function('window', 'document', 'setInterval', 'clearInterval', buildClaimConfirmScanScript())(
    win, doc, setInterval, clearInterval,
  );
  return posted;
}

{
  const msgs = runScan("Thank you for your service delay refund application. We'll email you within 5 days.");
  ok(msgs.length === 1 && msgs[0].type === 'claim-confirmation', 'script posts claim-confirmation on the success page');
}

{
  const msgs = runScan('You can only claim a service delay refund if delayed 15 minutes or more.');
  ok(msgs.length === 0, 'script stays silent on the Apply form');
}

{
  // Window latch: a second injection into the same page must not double-post.
  const posted: any[] = [];
  const win: any = { ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) } };
  const doc: any = { body: { innerText: 'Thank you for your service delay refund application.' } };
  const si = (_: any) => 1; const ci = (_: any) => {};
  const script = buildClaimConfirmScanScript();
  new Function('window', 'document', 'setInterval', 'clearInterval', script)(win, doc, si, ci);
  new Function('window', 'document', 'setInterval', 'clearInterval', script)(win, doc, si, ci);
  ok(posted.length === 1, 'window.__tflClaimConfirmScan latch prevents a double prompt');
}

console.log(`\ntest-claim-confirm-scan: all ${passed} assertions passed`);
