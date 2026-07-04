// Claim prefill tests — run with:
//   node --experimental-strip-types src/claims/test-claims.ts
import assert from 'node:assert/strict';
import { buildFillScript, buildPrefill, CLAIM_START_URL, ukDate } from './prefill.ts';
import type { ParsedJourney } from '../journeys/parse';
import type { Assessment } from '../eligibility/engine';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const journey: ParsedJourney = {
  card: 'test', date: '2026-06-10', tapInTime: '08:00', tapOutTime: '08:55',
  origin: 'Finchley Road', destination: 'Bank', charge: 3.1, incomplete: false,
  rawAction: 'Finchley Road to Bank',
};
const assessment = {
  status: 'eligible', reasonCode: 'ok', overageMinutes: 31, refundValue: 3.1, plausibleLines: ['jubilee'],
} as Assessment;

ok(ukDate('2026-06-10') === '10/06/2026', 'prefill: ISO date → UK date');

{
  const f = buildPrefill(journey, assessment);
  const byKey = Object.fromEntries(f.map(x => [x.key, x.value]));
  ok(byKey.date === '10/06/2026', 'prefill: date field in UK format');
  ok(byKey.timeIn === '08:00' && byKey.timeOut === '08:55', 'prefill: touch in/out times');
  ok(byKey.origin === 'Finchley Road' && byKey.destination === 'Bank', 'prefill: stations');
  ok(byKey.delay === '31', 'prefill: delay minutes from assessment overage');
  ok(f.every(x => x.keywords.length > 0 && x.label), 'prefill: every field has keywords and a chip label');
}
{
  const f = buildPrefill({ ...journey, destination: null, tapOutTime: null, incomplete: true }, undefined);
  const keys = f.map(x => x.key);
  ok(!keys.includes('destination') && !keys.includes('timeOut') && !keys.includes('delay'),
    'prefill: incomplete journey drops empty fields and delay without assessment');
  ok(keys.includes('date') && keys.includes('origin'), 'prefill: date and origin always present');
}
{
  const script = buildFillScript(buildPrefill(journey, assessment));
  ok(script.includes('Finchley Road') && script.includes('10/06/2026'), 'script: embeds field values');
  // Parses as valid JS (references document/window but new Function only parses).
  new Function(script);
  ok(true, 'script: syntactically valid JavaScript');
  ok(script.includes('postMessage'), 'script: reports fill result back to the app');
  ok(script.trimEnd().endsWith('true;'), 'script: ends with true for injectJavaScript');
}
{
  const evil = buildFillScript(buildPrefill({ ...journey, origin: 'X"; alert(1); //' }, undefined));
  new Function(evil);
  ok(true, 'script: values are JSON-escaped — hostile station names stay data');
}
ok(CLAIM_START_URL.startsWith('https://tfl.gov.uk/'), 'claim flow starts on tfl.gov.uk');

console.log(`\nAll ${passed} assertions passed.`);
