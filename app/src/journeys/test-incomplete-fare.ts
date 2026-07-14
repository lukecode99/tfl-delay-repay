// Tests for the incomplete-journey / max-fare overcharge detector (TfL-21).
//   node --experimental-strip-types src/journeys/test-incomplete-fare.ts
import { strict as assert } from 'node:assert';
import type { ParsedJourney } from './parse.ts';
import {
  buildOriginProfiles,
  detectOvercharges,
  totalDisputableRefund,
  claimableOvercharges,
  CLAIM_WINDOW_DAYS,
} from './incomplete-fare.ts';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

function j(over: Partial<ParsedJourney> = {}): ParsedJourney {
  return {
    card: 'card-1',
    date: '2026-06-30',
    tapInTime: '18:05',
    tapOutTime: '18:40',
    origin: 'Bond Street',
    destination: 'Northolt',
    charge: 2.8,
    incomplete: false,
    rawAction: 'Bond Street to Northolt',
    ...over,
  };
}

// A regular commute: 10 completed Bond Street → Northolt at £2.80.
function regularCommute(): ParsedJourney[] {
  const out: ParsedJourney[] = [];
  for (let d = 1; d <= 10; d++) {
    out.push(j({ date: `2026-06-${String(d).padStart(2, '0')}`, tapInTime: `18:0${d % 10}` }));
  }
  return out;
}

test('profile learns the modal destination and usual fare', () => {
  const profiles = buildOriginProfiles(regularCommute());
  const p = profiles.get('Bond Street')!;
  assert.equal(p.completeTrips, 10);
  assert.equal(p.topDestination, 'Northolt');
  assert.equal(p.topDestinationShare, 1);
  assert.equal(p.usualFare, 2.8);
});

test('incomplete + max fare on a regular route is flagged with refund', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', tapInTime: '18:07', destination: null, incomplete: true, charge: 8.9 }),
  ];
  const flags = detectOvercharges(journeys);
  assert.equal(flags.length, 1);
  const f = flags[0];
  assert.equal(f.origin, 'Bond Street');
  assert.equal(f.likelyDestination, 'Northolt');
  assert.equal(f.charged, 8.9);
  assert.equal(f.usualFare, 2.8);
  assert.equal(f.estimatedRefund, 6.1); // 8.90 − 2.80
  assert.equal(f.confidence, 'high'); // 100% share, 10 trips
});

test('incomplete journey charged the usual fare is NOT flagged', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: 2.8 }),
  ];
  assert.equal(detectOvercharges(journeys).length, 0);
});

test('origin with too little history is skipped', () => {
  const journeys = [
    j({ origin: 'Rare Station', destination: 'Somewhere', charge: 3 }), // 1 trip only
    j({ date: '2026-07-01', origin: 'Rare Station', destination: null, incomplete: true, charge: 9 }),
  ];
  assert.equal(detectOvercharges(journeys).length, 0);
});

test('small absolute overcharge below the noise floor is skipped', () => {
  const journeys = [
    ...regularCommute(),
    // £2.80 → £3.40 is only +£0.60, under the £1 floor
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: 3.4 }),
  ];
  assert.equal(detectOvercharges(journeys).length, 0);
});

test('confidence tiers reflect route regularity and sample size', () => {
  // Medium: 5 trips, 3 of them to the top dest (60% share)
  const mixed: ParsedJourney[] = [
    j({ date: '2026-06-01' }), j({ date: '2026-06-02' }), j({ date: '2026-06-03' }),
    j({ date: '2026-06-04', destination: 'Uxbridge', charge: 3.1 }),
    j({ date: '2026-06-05', destination: 'Ealing', charge: 2.5 }),
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: 8.9 }),
  ];
  const f = detectOvercharges(mixed);
  assert.equal(f.length, 1);
  assert.equal(f[0].confidence, 'medium');
});

test('total disputable refund sums candidates', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', tapInTime: '18:07', destination: null, incomplete: true, charge: 8.9 }),
    j({ date: '2026-07-02', tapInTime: '18:08', destination: null, incomplete: true, charge: 7.9 }),
  ];
  const flags = detectOvercharges(journeys);
  assert.equal(flags.length, 2);
  assert.equal(totalDisputableRefund(flags), 11.2); // 6.10 + 5.10
  // newest first
  assert.equal(flags[0].date, '2026-07-02');
});

test('journey with no charge cannot be an overcharge', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: null }),
  ];
  assert.equal(detectOvercharges(journeys).length, 0);
});

// --- Claim-window awareness (TfL-22) ---

test('without asOf, candidate is claimable with unknown age', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: 8.9 }),
  ];
  const f = detectOvercharges(journeys)[0];
  assert.equal(f.ageDays, null);
  assert.equal(f.claimStatus, 'claimable');
  assert.equal(f.claimDeadline, null);
});

test('overcharge older than 8 weeks is marked expired', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-04-01', destination: null, incomplete: true, charge: 8.9 }),
  ];
  // 2026-04-01 → 2026-07-14 is ~104 days, well past the 56-day window
  const f = detectOvercharges(journeys, { asOfISO: '2026-07-14' })[0];
  assert.equal(f.claimStatus, 'expired');
  assert.ok(f.ageDays! > CLAIM_WINDOW_DAYS);
  assert.equal(f.claimDeadline, '2026-05-27'); // 2026-04-01 + 56 days
});

test('overcharge under 48h old is pending-auto (hold off)', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-14', destination: null, incomplete: true, charge: 8.9 }),
  ];
  const f = detectOvercharges(journeys, { asOfISO: '2026-07-14' })[0];
  assert.equal(f.ageDays, 0);
  assert.equal(f.claimStatus, 'pending-auto');
});

test('overcharge inside the window and past 48h is claimable', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-07-01', destination: null, incomplete: true, charge: 8.9 }),
  ];
  const f = detectOvercharges(journeys, { asOfISO: '2026-07-14' })[0];
  assert.equal(f.ageDays, 13);
  assert.equal(f.claimStatus, 'claimable');
  assert.equal(f.claimDeadline, '2026-08-26'); // 2026-07-01 + 56 days
});

test('claimableOvercharges filters out expired and pending-auto', () => {
  const journeys = [
    ...regularCommute(),
    j({ date: '2026-04-01', tapInTime: '18:01', destination: null, incomplete: true, charge: 8.9 }), // expired
    j({ date: '2026-07-01', tapInTime: '18:02', destination: null, incomplete: true, charge: 8.9 }), // claimable
    j({ date: '2026-07-14', tapInTime: '18:03', destination: null, incomplete: true, charge: 8.9 }), // pending-auto
  ];
  const all = detectOvercharges(journeys, { asOfISO: '2026-07-14' });
  assert.equal(all.length, 3);
  const claimable = claimableOvercharges(all);
  assert.equal(claimable.length, 1);
  assert.equal(claimable[0].date, '2026-07-01');
});

console.log(`\n${n} tests passed`);
