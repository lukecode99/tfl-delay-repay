// Tests for journey clustering (TfL-PUSH: recommended-mode subscription generation).
import { clusterJourneys } from '../notifications/cluster';
import type { StoredJourney } from '../journeys/db';

function j(date: string, tapIn: string, tapOut: string, origin: string, dest: string): StoredJourney {
  return {
    id: Math.floor(Math.random() * 1e6),
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
const TUE = '2026-07-14';

describe('clusterJourneys', () => {
  it('returns empty array for no journeys', () => {
    expect(clusterJourneys([])).toEqual([]);
  });

  it('clusters journeys by day+hour and returns top-6', () => {
    const journeys: StoredJourney[] = [
      // Monday 08:xx cluster — 3 journeys (King's Cross to Bank)
      j(MON, '08:15', '08:52', "King's Cross St. Pancras", 'Bank'),
      j(MON, '08:20', '08:55', "King's Cross St. Pancras", 'Bank'),
      j(MON, '08:10', '08:48', "King's Cross St. Pancras", 'Bank'),
      // Tuesday 08:xx cluster — 2 journeys
      j(TUE, '08:30', '09:00', 'Waterloo', 'London Bridge'),
      j(TUE, '08:25', '08:55', 'Waterloo', 'London Bridge'),
    ];

    const clusters = clusterJourneys(journeys);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters.length).toBeLessThanOrEqual(6);

    // Most frequent cluster should come first
    expect(clusters[0].count).toBeGreaterThanOrEqual(clusters[1]?.count ?? 0);
  });

  it('sets windowStart 1h before avg tap-in', () => {
    const journeys = [j(MON, '08:00', '08:30', 'Baker Street', 'Bond Street')];
    const [c] = clusterJourneys(journeys);
    expect(c.windowStart).toBe('07:00');
    expect(c.windowEnd).toBe('09:30');
  });

  it('infers lines for known stations', () => {
    const journeys = [
      j(MON, '08:00', '08:20', 'Oxford Circus', 'Green Park'),
      j(MON, '08:05', '08:25', 'Oxford Circus', 'Green Park'),
    ];
    const [c] = clusterJourneys(journeys);
    // Oxford Circus serves bakerloo, central, victoria; Green Park serves jubilee, piccadilly, victoria
    // Shared = victoria
    expect(c.lines).toContain('victoria');
  });

  it('returns lines=[] for completely unknown stations', () => {
    const journeys = [j(MON, '09:00', '09:30', 'Nonexistent Station', 'Also Fake')];
    const [c] = clusterJourneys(journeys);
    expect(c.lines).toEqual([]);
  });

  it('handles missing tap-out gracefully', () => {
    const jNoOut: StoredJourney = { ...j(MON, '08:00', null as any, 'Holborn', 'Chancery Lane'), tapOutTime: null };
    expect(() => clusterJourneys([jNoOut])).not.toThrow();
  });
});
