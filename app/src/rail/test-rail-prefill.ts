// Rail claim prefill tests — run with:
//   node --experimental-strip-types src/rail/test-rail-prefill.ts
import assert from 'node:assert/strict';
import { buildAvantiPrefill, buildAvantiFillScript, AVANTI_CLAIM_URL } from './avanti-prefill.ts';
import { buildSouthernPrefill, buildSouthernFillScript, SOUTHERN_CLAIM_URL, GTR_CLAIM_URL } from './southern-prefill.ts';
import type { RailJourney } from './store-core.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}
function eq<T>(a: T, b: T, msg: string) {
  assert.deepStrictEqual(a, b, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const BASE_JOURNEY: RailJourney = {
  id: 1,
  originCrs: 'EUS',
  destinationCrs: 'MAN',
  departureDate: '2026-07-07',
  scheduledDepart: '07:03',
  actualDepart: '07:05',
  scheduledArrive: '09:18',
  actualArrive: '09:43',
  delayMinutes: 25,
  operator: 'avanti',
  ticketPricePence: 4550,    // £45.50
  ticketType: 'single',
  ticketRef: 'X3K9P',
  claimDeadline: '2026-08-04',
  claimedAt: null,
  claimStatus: 'pending',
  importedAt: '2026-07-07T10:00:00.000Z',
};

// --- URL constants ---
ok(AVANTI_CLAIM_URL.includes('avantiwestcoast.co.uk'), 'Avanti URL contains the domain');
ok(SOUTHERN_CLAIM_URL.includes('southernrailway.com'), 'Southern URL contains the domain');
ok(GTR_CLAIM_URL.includes('thameslink'), 'GTR URL is Thameslink');

// --- buildAvantiPrefill ---
{
  const fields = buildAvantiPrefill(BASE_JOURNEY, 25);
  const keys = fields.map(f => f.key);
  ok(keys.includes('date'), 'Avanti prefill: date field present');
  ok(keys.includes('from'), 'Avanti prefill: from field present');
  ok(keys.includes('to'), 'Avanti prefill: to field present');
  ok(keys.includes('departTime'), 'Avanti prefill: departTime field present');
  ok(keys.includes('delay'), 'Avanti prefill: delay field present');
  ok(keys.includes('fare'), 'Avanti prefill: fare field present');

  const dateF = fields.find(f => f.key === 'date')!;
  eq(dateF.value, '07/07/2026', 'Avanti prefill: date formatted as DD/MM/YYYY');

  const fromF = fields.find(f => f.key === 'from')!;
  ok(fromF.value === 'London Euston', 'Avanti prefill: origin CRS resolved to name');

  const toF = fields.find(f => f.key === 'to')!;
  ok(toF.value === 'Manchester Piccadilly', 'Avanti prefill: destination CRS resolved to name');

  const delayF = fields.find(f => f.key === 'delay')!;
  eq(delayF.value, '25', 'Avanti prefill: delay value is string');

  const fareF = fields.find(f => f.key === 'fare')!;
  eq(fareF.value, '45.50', 'Avanti prefill: fare formatted to 2dp (pence → pounds)');

  ok(fields.every(f => f.keywords.length > 0), 'Avanti prefill: all fields have keywords');
  ok(fields.every(f => f.value !== ''), 'Avanti prefill: no empty values');
}
{
  // No delay data — delay and band fields omitted
  const fields = buildAvantiPrefill(BASE_JOURNEY, null);
  ok(!fields.some(f => f.key === 'delay'), 'Avanti prefill: no delay field when delayMinutes null');
}
{
  // No fare
  const noFare: RailJourney = { ...BASE_JOURNEY, ticketPricePence: null };
  const fields = buildAvantiPrefill(noFare, 25);
  ok(!fields.some(f => f.key === 'fare'), 'Avanti prefill: no fare field when singleFare null');
}
{
  // No actual times
  const noActuals: RailJourney = { ...BASE_JOURNEY, scheduledArrive: null, actualArrive: null };
  const fields = buildAvantiPrefill(noActuals, 25);
  ok(!fields.some(f => f.key === 'arriveTime'), 'Avanti prefill: no arriveTime when scheduledArrive null');
  ok(!fields.some(f => f.key === 'actualArrive'), 'Avanti prefill: no actualArrive when actualArrive null');
}

// --- buildSouthernPrefill ---
{
  const journey: RailJourney = { ...BASE_JOURNEY, originCrs: 'VIC', destinationCrs: 'BTN', operator: 'southern', ticketPricePence: 2280 };
  const fields = buildSouthernPrefill(journey, 35);
  const keys = fields.map(f => f.key);
  ok(keys.includes('date'), 'Southern prefill: date present');
  ok(keys.includes('from'), 'Southern prefill: from present');
  ok(keys.includes('to'), 'Southern prefill: to present');
  ok(keys.includes('delay'), 'Southern prefill: delay present');
  ok(keys.includes('band'), 'Southern prefill: band present for eligible delay');

  const fromF = fields.find(f => f.key === 'from')!;
  ok(fromF.value === 'London Victoria', 'Southern prefill: VIC → London Victoria');

  const toF = fields.find(f => f.key === 'to')!;
  ok(toF.value === 'Brighton', 'Southern prefill: BTN → Brighton');

  const bandF = fields.find(f => f.key === 'band')!;
  ok(bandF.value.includes('50'), 'Southern prefill: 35 min → 50% band label');

  const fareF = fields.find(f => f.key === 'fare')!;
  eq(fareF.value, '22.80', 'Southern prefill: fare formatted');
}
{
  // Under-threshold delay → no band field
  const journey: RailJourney = { ...BASE_JOURNEY, originCrs: 'VIC', destinationCrs: 'BTN', operator: 'southern' };
  const fields = buildSouthernPrefill(journey, 10);
  ok(!fields.some(f => f.key === 'band'), 'Southern prefill: no band field for < 15 min delay');
}

// --- fill scripts are injectable strings ---
{
  const fields = buildAvantiPrefill(BASE_JOURNEY, 25);
  const script = buildAvantiFillScript(fields);
  ok(typeof script === 'string', 'Avanti fill script: is a string');
  ok(script.includes('ReactNativeWebView'), 'Avanti fill script: posts to ReactNativeWebView');
  ok(script.endsWith('; true;'), 'Avanti fill script: ends with "; true;"');
  ok(script.includes('London Euston'), 'Avanti fill script: embeds station name');
  ok(script.includes('45.50'), 'Avanti fill script: embeds fare');
  ok(!script.includes('undefined'), 'Avanti fill script: no undefined values');
}
{
  const fields = buildSouthernPrefill({ ...BASE_JOURNEY, originCrs: 'VIC', destinationCrs: 'BTN', operator: 'southern' }, 35);
  const script = buildSouthernFillScript(fields);
  ok(typeof script === 'string', 'Southern fill script: is a string');
  ok(script.includes('ReactNativeWebView'), 'Southern fill script: posts to ReactNativeWebView');
  ok(script.endsWith('; true;'), 'Southern fill script: ends with "; true;"');
  ok(script.includes('Brighton'), 'Southern fill script: embeds destination');
}

// --- run fill scripts against a stub DOM to verify they don't throw ---
{
  function runScript(script: string, dom: Record<string, unknown>): unknown {
    // Evaluate via Function to isolate from Node globals
    const fn = new Function('window', 'document', `
      var Event = window.Event;
      ${script}
    `);
    const messages: unknown[] = [];
    const rnWebView = { postMessage: (m: string) => messages.push(JSON.parse(m)) };
    const mockWindow = {
      ...dom,
      ReactNativeWebView: rnWebView,
      Event: class { type: string; init: object | undefined; constructor(type: string, init?: object) { this.type = type; this.init = init; } },
      HTMLInputElement: { prototype: {} },
      HTMLSelectElement: { prototype: {} },
      HTMLTextAreaElement: { prototype: {} },
    };
    fn(mockWindow, dom.document);
    return messages[0];
  }

  const noInputs = {
    document: {
      querySelectorAll: () => ({ length: 0 }),
      querySelector: () => null,
    },
  };
  const fields = buildAvantiPrefill(BASE_JOURNEY, 25);
  const script = buildAvantiFillScript(fields);
  const result = runScript(script, noInputs) as { type: string; filled: number; total: number };
  ok(result?.type === 'prefill', 'Avanti fill script: reports prefill result');
  ok(result?.filled === 0 && result?.total === fields.length, 'Avanti fill script: 0 filled on empty DOM, total = field count');
}
{
  // Hostile DOM — querySelectorAll throws
  function runScriptHostile(script: string): unknown {
    const fn = new Function('window', 'document', `
      var Event = window.Event;
      ${script}
    `);
    const messages: unknown[] = [];
    const mockWindow = {
      ReactNativeWebView: { postMessage: (m: string) => messages.push(JSON.parse(m)) },
      Event: class { type: string; constructor(type: string) { this.type = type; } },
      HTMLInputElement: { prototype: {} },
    };
    const hostile = { querySelectorAll: () => { throw new Error('hostile'); }, querySelector: () => null };
    fn(mockWindow, hostile);
    return messages[0];
  }
  const fields = buildSouthernPrefill({ ...BASE_JOURNEY, originCrs: 'VIC', destinationCrs: 'BTN', operator: 'southern' }, 35);
  const result = runScriptHostile(buildSouthernFillScript(fields)) as { type: string; filled: number; error?: string };
  ok(result?.type === 'prefill', 'Southern fill script: hostile DOM reports prefill type');
  // querySelectorAll errors are caught internally — script is resilient, filled = 0 not an error field
  ok(result?.filled === 0, 'Southern fill script: hostile DOM yields 0 fills (not a crash)');
}

console.log(`\ntest-rail-prefill: all ${passed} assertions passed.`);
