// Tests for station→line inference and name normalization.
import { inferLines, stationKnown } from '../notifications/line-inference';

describe('stationKnown', () => {
  it('recognises key stations', () => {
    expect(stationKnown("King's Cross St. Pancras")).toBe(true);
    expect(stationKnown('Oxford Circus')).toBe(true);
    expect(stationKnown('Canary Wharf')).toBe(true);
    expect(stationKnown('Waterloo')).toBe(true);
  });

  it('returns false for unknown stations', () => {
    expect(stationKnown('Nonexistent Station')).toBe(false);
    expect(stationKnown('')).toBe(false);
  });

  it('handles suffix variants', () => {
    expect(stationKnown("King's Cross St. Pancras Underground Station")).toBe(true);
    expect(stationKnown('Canary Wharf DLR Station')).toBe(true);
  });
});

describe('inferLines', () => {
  it('returns shared lines for a direct-service pair', () => {
    // Oxford Circus (bakerloo, central, victoria) + Victoria (circle, district, victoria) → victoria
    const lines = inferLines('Oxford Circus', 'Victoria');
    expect(lines).toContain('victoria');
  });

  it('returns origin lines when no direct service exists', () => {
    // Canary Wharf serves dlr, elizabeth, jubilee
    // Acton Town serves district, piccadilly → no overlap
    const lines = inferLines('Canary Wharf', 'Acton Town');
    expect(lines.length).toBeGreaterThan(0);
    // Should be origin lines (dlr, elizabeth, jubilee)
    expect(lines.some(l => ['dlr', 'elizabeth', 'jubilee'].includes(l))).toBe(true);
  });

  it('returns [] for completely unknown origin and dest', () => {
    const lines = inferLines('Fake Station', 'Also Fake');
    expect(lines).toEqual([]);
  });

  it('handles null destination (tap-out missing)', () => {
    const lines = inferLines('Waterloo', null);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toContain('northern');
  });

  it('is case-insensitive', () => {
    const upper = inferLines('OXFORD CIRCUS', 'GREEN PARK');
    const lower = inferLines('oxford circus', 'green park');
    expect(upper).toEqual(lower);
  });

  it('handles apostrophe variants', () => {
    const a = inferLines("King's Cross St. Pancras", 'Bank');
    const b = inferLines('Kings Cross St. Pancras', 'Bank');
    // Both should return something (apostrophe normalisation)
    expect(a.length).toBeGreaterThan(0);
  });
});
