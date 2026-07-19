// Tests for ALERT-ENTRY bucket maths and ALERT-SUGGEST profile pre-fill.
import { slotsFromUsualTime, minsToSlot, clusterToProfile } from '../disruptions/push-slots';
import type { JourneyCluster } from '../notifications/cluster';

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
    // center=720, range 705–735 → slots 23..24 (2 slots)
    expect(narrow.length).toBeLessThanOrEqual(3);
    const wide = slotsFromUsualTime('12:00', 120);
    expect(wide.length).toBeGreaterThan(narrow.length);
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
    // 08:15 = 495 min → slot 16 (floor(495/30)=16)
    const p = clusterToProfile(CLUSTER);
    expect(p.slots).toContain(minsToSlot(8 * 60 + 15));
  });

  it('sets enabled true', () => {
    expect(clusterToProfile(CLUSTER).enabled).toBe(true);
  });

  it('generates a unique id string', () => {
    expect(typeof clusterToProfile(CLUSTER).id).toBe('string');
    expect(clusterToProfile(CLUSTER).id.length).toBeGreaterThan(0);
  });
});
