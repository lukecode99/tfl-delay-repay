// Tests for TfL-REFRESH-DEEP: deep-pull one-time gate and period selection.
import { periodsForRefresh, lastNPeriods, HISTORY_MONTHS, DEEP_PULL_META_KEY } from '../journeys/direct-csv';

describe('periodsForRefresh', () => {
  it('returns HISTORY_MONTHS periods when deep pull not done', () => {
    const periods = periodsForRefresh('2026-07', false);
    expect(periods).toHaveLength(HISTORY_MONTHS);
  });

  it('returns 2 periods when deep pull is done', () => {
    const periods = periodsForRefresh('2026-07', true);
    expect(periods).toHaveLength(2);
  });

  it('routine periods match current and previous month', () => {
    const periods = periodsForRefresh('2026-07', true);
    expect(periods[0]).toBe('7|2026'); // current month unpadded
    expect(periods[1]).toBe('6|2026'); // previous month
  });

  it('handles year boundary correctly in routine mode', () => {
    const periods = periodsForRefresh('2026-01', true);
    expect(periods[0]).toBe('1|2026');
    expect(periods[1]).toBe('12|2025'); // crosses year boundary
  });

  it('deep pull periods start from current month going back', () => {
    const periods = periodsForRefresh('2026-07', false);
    expect(periods[0]).toBe('7|2026');
    expect(periods[periods.length - 1]).toBe(`${7 - HISTORY_MONTHS + 1 > 0 ? 7 - HISTORY_MONTHS + 1 : 7 - HISTORY_MONTHS + 1 + 12}|${7 - HISTORY_MONTHS + 1 > 0 ? 2026 : 2025}`);
  });

  it('deep pull includes 12-month span crossing a year', () => {
    const periods = periodsForRefresh('2026-03', false);
    expect(periods).toHaveLength(12);
    // 12 months back from March 2026 lands in April 2025
    expect(periods[periods.length - 1]).toBe('4|2025');
  });

  it('DEEP_PULL_META_KEY is a non-empty string', () => {
    expect(typeof DEEP_PULL_META_KEY).toBe('string');
    expect(DEEP_PULL_META_KEY.length).toBeGreaterThan(0);
  });
});

describe('lastNPeriods', () => {
  it('returns exactly n periods', () => {
    expect(lastNPeriods('2026-07', 3)).toHaveLength(3);
    expect(lastNPeriods('2026-07', 12)).toHaveLength(12);
  });

  it('newest period is first', () => {
    const periods = lastNPeriods('2026-07', 3);
    expect(periods[0]).toBe('7|2026');
    expect(periods[1]).toBe('6|2026');
    expect(periods[2]).toBe('5|2026');
  });

  it('months are unpadded (5 not 05)', () => {
    const periods = lastNPeriods('2026-05', 1);
    expect(periods[0]).toBe('5|2026');
  });

  it('handles January correctly', () => {
    const periods = lastNPeriods('2026-01', 2);
    expect(periods[0]).toBe('1|2026');
    expect(periods[1]).toBe('12|2025');
  });
});
