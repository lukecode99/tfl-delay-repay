// "Complete my journey" fill tests (TfL-OVERCHARGE-AUTO). Run with:
//   node --experimental-strip-types src/claims/test-complete-journey-fill.ts
// Exercises URL heuristics and the injected script against a stub DOM.
// No real station names or card ids in here.
import assert from 'node:assert/strict';
import {
  buildCompleteJourneyFillScript,
  incompleteJourneysUrl,
  isCompleteJourneyConfirmPage,
  isCompleteJourneyFormPage,
  type CompleteJourneyPlan,
} from './complete-journey-fill.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// ── URL heuristics ────────────────────────────────────────────────────────────

ok(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/CompleteMyJourney'),
  'form: CompleteMyJourney path');
ok(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/Complete-my-journey?id=1'),
  'form: Complete-my-journey with query');
ok(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/MyCards/123/IncompleteJourney/Fill'),
  'form: IncompleteJourney (singular) in path');
ok(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/CorrectJourney'),
  'form: CorrectJourney path');
ok(!isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/MyCards/IncompleteJourneys'),
  'form: IncompleteJourneys (plural) — the LIST page, not the form');
ok(!isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/Dashboard'),
  'form: Dashboard is not the form page');
ok(!isCompleteJourneyFormPage('https://www.tfl.gov.uk/CompleteMyJourney'),
  'form: wrong domain (www. not contactless.)');
ok(!isCompleteJourneyFormPage(''),
  'form: empty string → false');

ok(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/CompleteMyJourney/Confirm'),
  'confirm: /Confirm suffix');
ok(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/Success?ref=abc'),
  'confirm: /Success path');
ok(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/ThankYou'),
  'confirm: /ThankYou path');
ok(!isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/CompleteMyJourney'),
  'confirm: form page (no confirm/success) → false');
ok(!isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/MyCards'),
  'confirm: MyCards → false');

ok(incompleteJourneysUrl('1234567890') === 'https://contactless.tfl.gov.uk/MyCards/1234567890/IncompleteJourneys',
  'incompleteJourneysUrl: encodes the card ID in the path');
ok(incompleteJourneysUrl('test card') === 'https://contactless.tfl.gov.uk/MyCards/test%20card/IncompleteJourneys',
  'incompleteJourneysUrl: spaces percent-encoded');

// ── Stub DOM for script execution ─────────────────────────────────────────────

function makeEnv() {
  const store: Record<string, string> = {};
  const proto = function (this: any) {};
  Object.defineProperty(proto.prototype, 'value', {
    configurable: true,
    set(this: any, v: any) { this._value = v; if (this.name) store[this.name] = String(v); },
    get(this: any) { return this._value ?? ''; },
  });
  const HTMLInputElement: any = proto;
  const HTMLSelectElement: any = function (this: any) {};
  Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    configurable: true,
    set(this: any, v: any) { this._value = v; if (this.name) store[this.name] = String(v); },
    get(this: any) { return this._value ?? ''; },
  });

  let seq = 0;
  const mk = (name: string, over: any = {}) => {
    const isSelect = over.tagName === 'SELECT';
    const el: any = Object.create(isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    el.__k = name + '#' + (seq++);
    el.name = name;
    el.id = over.id ?? '';
    el.tagName = over.tagName ?? 'INPUT';
    el.type = (over.type ?? 'text').toLowerCase();
    el._value = '';
    el.options = over.options ?? undefined;
    el.selectedIndex = -1;
    el.placeholder = over.placeholder ?? '';
    el.textContent = over.textContent ?? '';
    el.getAttribute = (a: string) => a === 'for' ? (over.htmlFor ?? '') : '';
    el.dispatchEvent = () => true;
    return el;
  };

  const posted: any[] = [];
  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    Event: function (this: any, t: string) { this.type = t; },
    HTMLInputElement,
    HTMLSelectElement,
  };
  return { store, posted, win, mk };
}

function runFill(plan: CompleteJourneyPlan, buildDoc: (mk: any) => any) {
  const env = makeEnv();
  const doc = buildDoc(env.mk);
  new Function('window', 'document', buildCompleteJourneyFillScript(plan))(env.win, doc);
  return { posted: env.posted, store: env.store };
}

// fill via known name selector (SELECT with matching option)
{
  const plan: CompleteJourneyPlan = { exitStation: 'Northolt' };
  const { posted, store } = runFill(plan, (mk) => {
    const sel = mk('FinishNlcId', {
      tagName: 'SELECT',
      options: [
        { value: '', textContent: 'Select station', text: 'Select station' },
        { value: '564', textContent: 'Northolt', text: 'Northolt', selected: false },
        { value: '600', textContent: 'South Ruislip', text: 'South Ruislip', selected: false },
      ],
    });
    const byName: Record<string, any> = { FinishNlcId: sel };
    return {
      querySelector: (sel2: string) => { const m = /name="([^"]+)"/.exec(sel2); return m ? byName[m[1]] ?? null : null; },
      querySelectorAll: () => [sel],
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 1 && msg.total === 1, 'select fill: reports 1 filled');
  ok(store.FinishNlcId === '564', 'select fill: option value written to hidden field');
  ok(msg.results[0].via === 'select', 'select fill: via=select in result');
}

// fill via text input found by name selector
{
  const plan: CompleteJourneyPlan = { exitStation: 'West Ruislip' };
  const { posted, store } = runFill(plan, (mk) => {
    const input = mk('ExitStation');
    return {
      querySelector: (sel: string) => /name="ExitStation"/.test(sel) ? input : null,
      querySelectorAll: () => [input],
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 1, 'input fill: reports 1 filled');
  ok(store.ExitStation === 'West Ruislip', 'input fill: value written to input');
  ok(msg.results[0].via === 'input', 'input fill: via=input in result');
}

// fallback: label-text search
{
  const plan: CompleteJourneyPlan = { exitStation: 'Rayners Lane' };
  const { posted, store } = runFill(plan, (mk) => {
    const input = mk('customStationField', { id: 'exitBox' });
    const label: any = { textContent: 'Exit station', htmlFor: 'exitBox', getAttribute: (a: string) => a === 'for' ? 'exitBox' : '' };
    return {
      querySelector: () => null,  // no name match
      querySelectorAll: (sel: string) => sel === 'label' ? [label] : sel.includes('[name]') ? [input] : [],
      getElementById: (id: string) => id === 'exitBox' ? input : null,
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 1, 'label fallback: reports 1 filled');
  ok(store.customStationField === 'Rayners Lane', 'label fallback: value written via label lookup');
}

// select with no matching option → not-filled, not a throw
{
  const plan: CompleteJourneyPlan = { exitStation: 'Unknown Halt' };
  const { posted } = runFill(plan, (mk) => {
    const sel = mk('FinishNlcId', {
      tagName: 'SELECT',
      options: [
        { value: '564', textContent: 'Northolt', text: 'Northolt', selected: false },
      ],
    });
    return {
      querySelector: (s: string) => /name="FinishNlcId"/.test(s) ? sel : null,
      querySelectorAll: () => [sel],
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 0 && msg.results[0].via === 'no-option',
    'no-option: reports 0 filled, via=no-option, no throw');
}

// no matching field at all → schema still emitted, filled=0, no throw
{
  const plan: CompleteJourneyPlan = { exitStation: 'Somewhere' };
  const { posted } = runFill(plan, (mk) => {
    const unrelated = mk('__csrf');
    return {
      querySelector: () => null,
      querySelectorAll: (sel: string) => sel === 'label' ? [] : [unrelated],
      getElementById: () => null,
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 0, 'not-found: reports 0 filled');
  ok(msg.results[0].via === 'not-found', 'not-found: via=not-found in result');
  ok(Array.isArray(msg.schema), 'not-found: schema always emitted');
}

// prefix match: option "Northolt [Zone 5]" matches plan "Northolt"
{
  const plan: CompleteJourneyPlan = { exitStation: 'Northolt' };
  const { posted, store } = runFill(plan, (mk) => {
    const sel = mk('FinishStation', {
      tagName: 'SELECT',
      options: [
        { value: 'NTH', textContent: 'Northolt [Zone 5]', text: 'Northolt [Zone 5]', selected: false },
      ],
    });
    return {
      querySelector: (s: string) => /name="FinishStation"/.test(s) ? sel : null,
      querySelectorAll: () => [sel],
    };
  });
  const msg = posted.find((p: any) => p.type === 'complete-journey-fill');
  ok(!!msg && msg.filled === 1, 'prefix match: "Northolt" matches "Northolt [Zone 5]"');
  ok(store.FinishStation === 'NTH', 'prefix match: correct option value selected');
}

console.log(`\ntest-complete-journey-fill: all ${passed} assertions passed`);
