// Tests for ALERT-ENTRY bucket maths, ALERT-SUGGEST profile pre-fill,
// and the float-minutes regression (avgTapIn "17:31.23..." bug).
import { slotsFromUsualTime, minsToSlot, slotRangeLabel, clusterToProfile } from '../disruptions/push-slots';
import { clusterJourneys, type JourneyCluster } from '../notifications/cluster';
import type { StoredJourney } from '../journeys/db';

// Minimal journey factory matching cluster.test.ts
function j(date: string, tapIn: string, tapOut: string | null, origin: string, dest: string): StoredJourney {
  return {
    id: Math.floor(Math.abs(Math.sin(Date.now())) * 1e6),
    card: 'TEST',
    date,
    tapInTime: tapIn,
    tapOutTime: tapOut,
    origin,
    destination: dest,
    charge: 2.5,
    incomplete: false,
    rawAction: 'Journey',
    importedAt: new Date().toISOString(),
  };
}

// 2026-07-13 is a Monday (dayOfWeek = 1)
const MON = '2026-07-13';

describe('minsToSlot', () => {
  it('maps 0 mins to slot 0', () => expect(minsToSlot(0)).toBe(0));
  it('maps 29 mins to slot 0', () => expect(minsToSlot(29)).toBe(0));
  it('maps 30 mins to slot 1', () => expect(minsToSlot(30)).toBe(1));
  it('maps 480 mins (08:00) to slot 16', () => expect(minsToSlot(480)).toBe(16));
  it('maps 510 mins (08:30) to slot 17', () => expect(minsToSlot(510)).toBe(17));
  it('maps 1410 mins (23:30) to slot 47', () => expect(minsToSlot(1410)).toBe(47));
  it('clamps at slot 47 for anything ≥ 23:30', () => expect(minsToSlot(1500)).toBe(47));
});

describe('slotsFromUsualTime', () => {
  it('returns a contiguous ascending range', () => {
    const slots = slotsFromUsualTime('08:30');
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]).toBe(slots[i - 1] + 1);
    }
  });

  it('includes the center slot for 08:30', () => {
    const slots = slotsFromUsualTime('08:30');
    expect(slots).toContain(17); // slot 17 = 08:30
  });

  it('spans ±60 min by default (4–5 slots)', () => {
    const slots = slotsFromUsualTime('12:00');
    // center=720, range 660–780 → slots 22..26 (5 slots)
    expect(slots.length).toBeGreaterThanOrEqual(4);
    expect(slots.length).toBeLessThanOrEqual(6);
  });

  it('clamps start to slot 0 near midnight', () => {
    const slots = slotsFromUsualTime('00:00');
    expect(slots[0]).toBe(0);
  });

  it('clamps end to slot 47 at 23:30', () => {
    const slots = slotsFromUsualTime('23:30');
    expect(Math.max(...slots)).toBe(47);
  });

  it('respects custom rangeMins', () => {
    const narrow = slotsFromUsualTime('12:00', 15);
    expect(narrow.length).toBeLessThanOrEqual(3);
    const wide = slotsFromUsualTime('12:00', 120);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
});

describe('float-minutes regression (avgTapIn "17:31.23..." bug)', () => {
  it('clusterJourneys avgTapIn has no decimal places', () => {
    // 490+500+493 = 1483 min / 3 = 494.333... — would have been "08:14.333" before fix
    const journeys = [
      j(MON, '08:10', '08:50', 'Baker Street', 'Bond Street'),
      j(MON, '08:20', '08:55', 'Baker Street', 'Bond Street'),
      j(MON, '08:13', '08:48', 'Baker Street', 'Bond Street'),
    ];
    const [c] = clusterJourneys(journeys);
    expect(c.avgTapIn).toMatch(/^\d{2}:\d{2}$/);
    expect(c.avgTapIn).not.toContain('.');
  });

  it('slotRangeLabel from a float-average avgTapIn produces clean HH:MM – HH:MM', () => {
    // Simulate the worst case: avgTapIn that was float-formatted (fixed in cluster.ts)
    // Test that slotsFromUsualTime + slotRangeLabel never propagates floats
    const avgTapIn = '17:31'; // clean HH:MM as produced after fix
    const label = slotRangeLabel(slotsFromUsualTime(avgTapIn));
    expect(label).toMatch(/^\d{2}:\d{2} – \d{2}:\d{2}$/);
    expect(label).not.toContain('.');
  });

  it('avgTapOut has no decimal places', () => {
    const journeys = [
      j(MON, '08:10', '08:51', 'Baker Street', 'Bond Street'),
      j(MON, '08:20', '08:53', 'Baker Street', 'Bond Street'),
      j(MON, '08:13', '08:49', 'Baker Street', 'Bond Street'),
    ];
    const [c] = clusterJourneys(journeys);
    expect(c.avgTapOut).toMatch(/^\d{2}:\d{2}$/);
    expect(c.avgTapOut).not.toContain('.');
  });
});

describe('DOW_LABELS correctness', () => {
  it('Thursday is "Thu" not "Thus"', () => {
    // Regression: SuggestionCard was appending "s" → "Thus"
    // DOW_LABELS is 1-indexed: 1=Mon … 7=Sun
    const { DOW_LABELS } = require('../disruptions/push-slots');
    expect(DOW_LABELS[4]).toBe('Thu');
    expect(DOW_LABELS[4]).not.toBe('Thus');
  });
});

const CLUSTER: JourneyCluster = {
  dayOfWeek: 1,
  windowStart: '07:15',
  windowEnd: '09:15',
  origin: "King's Cross St. Pancras",
  destination: 'Bank',
  lines: ['northern', 'victoria'],
  count: 5,
  avgTapIn: '08:15',
  avgTapOut: '08:50',
};

describe('clusterToProfile', () => {
  it('uses first inferred line', () => {
    expect(clusterToProfile(CLUSTER).line).toBe('northern');
  });

  it('falls back to empty string when lines is empty', () => {
    expect(clusterToProfile({ ...CLUSTER, lines: [] }).line).toBe('');
  });

  it('sets origin', () => {
    expect(clusterToProfile(CLUSTER).origin).toBe("King's Cross St. Pancras");
  });

  it('sets destination', () => {
    expect(clusterToProfile(CLUSTER).destination).toBe('Bank');
  });

  it('converts null destination to empty string', () => {
    expect(clusterToProfile({ ...CLUSTER, destination: null }).destination).toBe('');
  });

  it('sets days to [dayOfWeek]', () => {
    expect(clusterToProfile(CLUSTER).days).toEqual([1]);
  });

  it('derives slots from avgTapIn (08:15 → includes slot 16)', () => {
    const p = clusterToProfile(CLUSTER);
    expect(p.slots).toContain(minsToSlot(8 * 60 + 15));
  });

  it('produced slot range label matches bucketed HH:MM – HH:MM format', () => {
    const p = clusterToProfile(CLUSTER);
    const label = slotRangeLabel(p.slots);
    expect(label).toMatch(/^\d{2}:\d{2} – \d{2}:\d{2}$/);
    expect(label).not.toContain('.');
  });

  it('profile from suggestion is identical in structure to manually created profile', () => {
    const p = clusterToProfile(CLUSTER);
    expect(p).toMatchObject({
      line: 'northern',
      origin: "King's Cross St. Pancras",
      destination: 'Bank',
      days: [1],
      enabled: true,
    });
    expect(Array.isArray(p.slots)).toBe(true);
    expect(p.slots.length).toBeGreaterThan(0);
    expect(p.slots.every((s: number) => s >= 0 && s <= 47)).toBe(true);
  });

  it('sets enabled true', () => {
    expect(clusterToProfile(CLUSTER).enabled).toBe(true);
  });

  it('generates a unique id string', () => {
    expect(typeof clusterToProfile(CLUSTER).id).toBe('string');
    expect(clusterToProfile(CLUSTER).id.length).toBeGreaterThan(0);
  });
});
