// Apply-form direct-fill tests (TfL-21). Run with:
//   node --experimental-strip-types src/claims/test-apply-fill.ts
// The script test executes the exact injected string against a stub DOM, same
// pattern as test-claim-capture.ts. No real station NLCs or card ids in here.
import assert from 'node:assert/strict';
import {
  buildApplyPlan,
  buildDirectFillScript,
  modeIdForLine,
  ukDate,
  type ApplyField,
} from './apply-fill';
import { normStation, resolveNlc } from './nlc-map';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- modeIdForLine: line → ModeId (captured 0/20/5/101) ---
ok(modeIdForLine('piccadilly') === 0 && modeIdForLine('victoria') === 0,
  'mode: tube lines → 0 (London Underground)');
ok(modeIdForLine('dlr') === 5 && modeIdForLine('elizabeth') === 101,
  'mode: DLR → 5, Elizabeth line → 101');
ok(modeIdForLine('london-overground') === 20 && modeIdForLine('mildmay') === 20,
  'mode: Overground incl. named lines → 20');
ok(modeIdForLine('national-rail') === null && modeIdForLine(undefined) === null,
  'mode: unknown / undefined line → null (left for the user)');

// --- ukDate ---
ok(ukDate('2026-07-04') === '04/07/2026', 'ukDate: ISO → DD/MM/YYYY');

// --- normStation / resolveNlc ---
ok(normStation('Ruislip [London Underground]') === 'ruislip'
  && normStation('  RUISLIP  ') === 'ruislip',
  'normStation: strips [suffix], lowercases, trims');
ok(normStation('Hammersmith & City') === 'hammersmith and city'
  && normStation("King's Cross St. Pancras") === 'kings cross st pancras',
  'normStation: & → and, punctuation dropped');
{
  const map = {
    ruislip: [{ nlc: 691, modes: [0] }],
    'kings cross st pancras': [{ nlc: 625, modes: [0] }],
    // interchange: same normalised name, three NLCs on different modes
    'canary wharf': [{ nlc: 852, modes: [0] }, { nlc: 842, modes: [5] }, { nlc: 6560, modes: [101] }],
  };
  ok(resolveNlc('Ruislip [London Underground]', 0, map) === 691
    && resolveNlc('ruislip', null, map) === 691,
    'resolveNlc: single candidate → exact normalised match (mode ignored)');
  ok(resolveNlc('Kings Cross', 0, map) === 625,
    'resolveNlc: prefix tolerance (missing trailing words)');
  ok(resolveNlc('Canary Wharf', 5, map) === 842 && resolveNlc('Canary Wharf', 101, map) === 6560,
    'resolveNlc: interchange disambiguated by ModeId (DLR=842, EL=6560)');
  ok(resolveNlc('Canary Wharf', null, map) === null && resolveNlc('Canary Wharf', 20, map) === null,
    'resolveNlc: interchange with no / non-matching mode → null (leaves for user)');
  ok(resolveNlc('Nowhere Central', 0, map) === null && resolveNlc('', 0, map) === null,
    'resolveNlc: unknown / empty → null (never guesses)');
}

// --- buildApplyPlan: journey + assessment → exact Apply fields ---
{
  const journey: any = { date: '2026-07-04', tapInTime: '10:32', origin: 'Ruislip [London Underground]', destination: 'Canary Wharf' };
  const assessment: any = { disruption: { line: 'jubilee' }, overageMinutes: 35 };
  const map = { ruislip: [{ nlc: 691, modes: [0] }], 'canary wharf': [{ nlc: 852, modes: [0] }, { nlc: 842, modes: [5] }] };
  const resolver = (n: string, m: number | null) => resolveNlc(n, m, map);
  const plan = buildApplyPlan(journey, assessment, resolver);
  const byName = (n: string) => plan.fields.find(f => f.name === n);
  ok(byName('ModeId')?.value === '0' && byName('ModeId')?.kind === 'select',
    'plan: ModeId resolved from line, as a select');
  ok(byName('StartNlcId')?.value === '691' && byName('StartNlcId')?.kind === 'station'
    && byName('StartNlcId')?.display === 'Ruislip',
    'plan: StartNlcId = origin NLC, display carries clean station name');
  ok(byName('FinishNlcId')?.value === '852' && byName('FinishNlcId')?.display === 'Canary Wharf',
    'plan: FinishNlcId = destination NLC picked by mode (Jubilee → LU 852, not DLR)');
  ok(byName('JourneyDate')?.value === '04/07/2026'
    && byName('JourneyStartTimeHours')?.value === '10'
    && byName('JourneyStartTimeMins')?.value === '32'
    && byName('DelayLengthString')?.value === '35',
    'plan: date DD/MM/YYYY, hours/mins split, delay minutes');
  ok(plan.unresolved.length === 0, 'plan: everything resolved → no unresolved fields');
}
{
  // A station missing from the map is reported, not guessed; mode too.
  const journey: any = { date: '2026-07-04', origin: 'Mystery Halt', destination: 'Ruislip' };
  const assessment: any = { plausibleLines: [] };
  const resolver = (n: string, m: number | null) => resolveNlc(n, m, { ruislip: [{ nlc: 691, modes: [0] }] });
  const plan = buildApplyPlan(journey, assessment, resolver);
  ok(!plan.fields.some(f => f.name === 'StartNlcId') && plan.unresolved.some(u => u.indexOf('Mystery Halt') !== -1),
    'plan: unmapped origin → no StartNlcId field, listed in unresolved');
  ok(plan.fields.some(f => f.name === 'FinishNlcId' && f.value === '691') && plan.unresolved.indexOf('Mode') !== -1,
    'plan: mapped destination still filled; missing mode reported');
}

// ---------------------------------------------------------------------------
// Stub DOM for the injected script. A control is a plain object created over a
// prototype whose `value` setter records writes (so the script's native-setter
// path is what's exercised). closest()/querySelectorAll() are wired per-test.
// ---------------------------------------------------------------------------
function makeEnv() {
  const store: Record<string, string> = {};
  function proto(this: any) {}
  Object.defineProperty(proto.prototype, 'value', {
    configurable: true,
    set(this: any, v: any) { this._value = v; store[this.name] = String(v); },
    get(this: any) { return this._value; },
  });
  const HTMLInputElement: any = proto;
  const HTMLSelectElement: any = function HTMLSelectElement(this: any) {};
  Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    configurable: true,
    set(this: any, v: any) { this._value = v; store[this.name] = String(v); },
    get(this: any) { return this._value; },
  });

  let seq = 0;
  const mk = (name: string, over: any = {}) => {
    const isSelect = over.tagName === 'SELECT';
    const el: any = Object.create(isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    el.__k = name + '#' + (seq++);
    el.name = name;
    el.id = over.id ?? '';
    el.tagName = over.tagName ?? 'INPUT';
    el.type = over.type ?? 'text';
    el._value = '';
    el.options = over.options;
    el.selectedIndex = -1;
    el.placeholder = over.placeholder ?? '';
    el.dispatchEvent = () => true;
    el.getAttribute = (a: string) => (a === 'aria-label' ? over.ariaLabel ?? '' : '');
    el.closest = (_sel: string) => null; // per-test override
    return el;
  };

  const win: any = {
    ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    Event: function (this: any, t: string) { this.type = t; },
    HTMLInputElement,
    HTMLSelectElement,
  };
  const posted: any[] = [];
  return { store, posted, win, mk, HTMLInputElement, HTMLSelectElement };
}

/** Run the injected script against a set of controls + a form element. */
function runFill(fields: ApplyField[], build: (mk: any) => { controls: any[]; form: any }) {
  const env = makeEnv();
  const { controls, form } = build(env.mk);
  const byName: Record<string, any> = {};
  controls.forEach(c => { byName[c.name] = c; });
  const doc: any = {
    querySelector: (sel: string) => {
      const m = /name="([^"]+)"/.exec(sel);
      if (m) return byName[m[1]] ?? null;
      if (sel.indexOf('ServiceDelayRefunds') !== -1) return form ?? null;
      return null;
    },
    querySelectorAll: () => controls,
  };
  new Function('window', 'document', buildDirectFillScript(fields))(env.win, doc);
  return { posted: env.posted, store: env.store, byName };
}

function main() {
  // input + select fill by exact name; schema is reported with select options
  {
    const fields: ApplyField[] = [
      { name: 'ModeId', value: '0', kind: 'select', label: 'Mode' },
      { name: 'JourneyDate', value: '04/07/2026', kind: 'input', label: 'Date' },
      { name: 'DelayLengthString', value: '35', kind: 'input', label: 'Delay (min)' },
    ];
    const { posted, store } = runFill(fields, (mk) => {
      const form: any = {};
      const controls = [
        mk('ModeId', { tagName: 'SELECT', options: [{ value: '-1', textContent: 'Select' }, { value: '0', textContent: 'London Underground' }, { value: '20', textContent: 'London Overground' }] }),
        mk('JourneyDate'),
        mk('DelayLengthString'),
        mk('StartNlcId', { type: 'hidden' }),
      ];
      controls.forEach(c => { c.closest = (sel: string) => (sel.indexOf('form') !== -1 && sel.indexOf('group') === -1 ? form : null); });
      form.querySelectorAll = () => controls;
      return { controls, form };
    });
    const msg = posted.find(p => p.type === 'apply-fill');
    ok(!!msg && msg.filled === 3 && msg.total === 3, 'fill: all three fields report filled');
    ok(store.ModeId === '0' && store.JourneyDate === '04/07/2026' && store.DelayLengthString === '35',
      'fill: select value + text inputs written by exact name');
    const modeRow = msg.schema.find((r: any) => r.name === 'ModeId');
    ok(!!modeRow && modeRow.tag === 'SELECT' && Array.isArray(modeRow.options) && modeRow.options.some((o: any) => o.v === '0'),
      'fill: schema dump captures the mode select + its options');
  }

  // select value not among options → reported no-option, not silently "filled"
  {
    const fields: ApplyField[] = [{ name: 'ModeId', value: '999', kind: 'select', label: 'Mode' }];
    const { posted } = runFill(fields, (mk) => {
      const form: any = {};
      const controls = [mk('ModeId', { tagName: 'SELECT', options: [{ value: '0', textContent: 'Underground' }] })];
      controls.forEach(c => { c.closest = () => form; });
      form.querySelectorAll = () => controls;
      return { controls, form };
    });
    const msg = posted.find(p => p.type === 'apply-fill');
    ok(msg.filled === 0 && msg.results[0].via === 'no-option',
      'fill: unknown select value is reported no-option, never faked');
  }

  // station: hidden NLC set + visible typeahead box gets the name
  {
    const fields: ApplyField[] = [{ name: 'StartNlcId', value: '564', kind: 'station', label: 'From', display: 'Ruislip' }];
    const { posted, store } = runFill(fields, (mk) => {
      const form: any = {};
      const group: any = {};
      const hidden = mk('StartNlcId', { type: 'hidden' });
      const box = mk('StartStationBox', { placeholder: 'Start station' });
      hidden.closest = (sel: string) => (sel.indexOf('group') !== -1 ? group : sel.indexOf('form') !== -1 ? form : null);
      box.closest = () => group;
      group.querySelectorAll = () => [hidden, box];
      form.querySelectorAll = () => [hidden, box];
      return { controls: [hidden, box], form };
    });
    const msg = posted.find(p => p.type === 'apply-fill');
    ok(msg.filled === 1 && store.StartNlcId === '564', 'station: hidden NLC field set to the numeric code');
    ok(store.StartStationBox === 'Ruislip' && msg.results[0].via === 'nlc+display',
      'station: visible typeahead box shows the station name');
  }

  // missing field → reported not-found, script never throws
  {
    const fields: ApplyField[] = [{ name: 'Ghost', value: 'x', kind: 'input', label: 'Ghost' }];
    const { posted } = runFill(fields, (mk) => {
      const form: any = { querySelectorAll: () => [] };
      return { controls: [mk('Other')], form };
    });
    const msg = posted.find(p => p.type === 'apply-fill');
    ok(msg.filled === 0 && msg.results[0].via === 'not-found', 'fill: absent field reported not-found, no throw');
  }

  console.log(`\n${passed} assertions passed`);
}

main();
