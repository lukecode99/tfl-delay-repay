// Tests for TfL-REFRESH-DEEP: deep-pull one-time gate and period selection.
// TfL-MODE-SWITCH: per-mode deep pull key.
// TfL-DEEPPULL-PROOF: period-level coverage marker helpers.
import {
  periodsForRefresh,
  lastNPeriods,
  HISTORY_MONTHS,
  DEEP_PULL_META_KEY,
  deepPullMetaKeyFor,
  deepPullCoveredPeriods,
  isDeepPullComplete,
  mergeDeepPullCoverage,
} from '../journeys/direct-csv';

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

describe('deepPullMetaKeyFor', () => {
  it('contactless returns the legacy key for backwards compat', () => {
    expect(deepPullMetaKeyFor('contactless')).toBe(DEEP_PULL_META_KEY);
  });

  it('oyster returns a mode-specific key distinct from the legacy key', () => {
    expect(deepPullMetaKeyFor('oyster')).not.toBe(DEEP_PULL_META_KEY);
    expect(deepPullMetaKeyFor('oyster')).toContain('oyster');
  });

  it('both returns a mode-specific key distinct from the legacy key', () => {
    expect(deepPullMetaKeyFor('both')).not.toBe(DEEP_PULL_META_KEY);
    expect(deepPullMetaKeyFor('both')).toContain('both');
  });

  it('oyster and both keys are distinct from each other', () => {
    expect(deepPullMetaKeyFor('oyster')).not.toBe(deepPullMetaKeyFor('both'));
  });

  it('all three keys are non-empty strings', () => {
    (['contactless', 'oyster', 'both'] as const).forEach(m => {
      expect(typeof deepPullMetaKeyFor(m)).toBe('string');
      expect(deepPullMetaKeyFor(m).length).toBeGreaterThan(0);
    });
  });
});

describe('deepPullCoveredPeriods', () => {
  it('returns empty set for null', () => {
    expect(deepPullCoveredPeriods(null).size).toBe(0);
  });

  it('returns empty set for legacy done marker', () => {
    expect(deepPullCoveredPeriods('done').size).toBe(0);
  });

  it('returns empty set for unparseable string', () => {
    expect(deepPullCoveredPeriods('not-json').size).toBe(0);
  });

  it('returns empty set for non-array JSON', () => {
    expect(deepPullCoveredPeriods('{"period":"7|2026"}').size).toBe(0);
  });

  it('returns the stored periods as a set', () => {
    const covered = deepPullCoveredPeriods('["7|2026","6|2026"]');
    expect(covered.size).toBe(2);
    expect(covered.has('7|2026')).toBe(true);
    expect(covered.has('6|2026')).toBe(true);
  });

  it('filters out non-string array entries', () => {
    const covered = deepPullCoveredPeriods('["7|2026",null,42]');
    expect(covered.size).toBe(1);
    expect(covered.has('7|2026')).toBe(true);
  });
});

describe('isDeepPullComplete', () => {
  it('returns false for null marker', () => {
    expect(isDeepPullComplete(null, '2026-07')).toBe(false);
  });

  it('returns false for legacy done marker', () => {
    expect(isDeepPullComplete('done', '2026-07')).toBe(false);
  });

  it('returns false when marker covers fewer than HISTORY_MONTHS periods', () => {
    const partial = JSON.stringify(lastNPeriods('2026-07', HISTORY_MONTHS - 1));
    expect(isDeepPullComplete(partial, '2026-07')).toBe(false);
  });

  it('returns true when marker covers all HISTORY_MONTHS periods for nowISO', () => {
    const full = JSON.stringify(lastNPeriods('2026-07', HISTORY_MONTHS));
    expect(isDeepPullComplete(full, '2026-07')).toBe(true);
  });

  it('returns false when marker is full but nowISO has moved forward a month', () => {
    const oldFull = JSON.stringify(lastNPeriods('2026-06', HISTORY_MONTHS));
    // 2026-07 requires '7|2026' which isn't in oldFull
    expect(isDeepPullComplete(oldFull, '2026-07')).toBe(false);
  });
});

describe('mergeDeepPullCoverage', () => {
  it('serialises new periods into a JSON array when existing is null', () => {
    const result = mergeDeepPullCoverage(null, ['7|2026', '6|2026']);
    const arr = JSON.parse(result);
    expect(arr).toContain('7|2026');
    expect(arr).toContain('6|2026');
  });

  it('merges with existing coverage', () => {
    const existing = JSON.stringify(['6|2026']);
    const result = mergeDeepPullCoverage(existing, ['7|2026']);
    const arr = JSON.parse(result);
    expect(arr).toContain('6|2026');
    expect(arr).toContain('7|2026');
  });

  it('treats legacy done as empty — new periods are not lost', () => {
    const result = mergeDeepPullCoverage('done', ['7|2026']);
    const arr = JSON.parse(result);
    expect(arr).toContain('7|2026');
    expect(arr.length).toBe(1);
  });

  it('deduplicates periods', () => {
    const existing = JSON.stringify(['7|2026', '6|2026']);
    const result = mergeDeepPullCoverage(existing, ['7|2026', '5|2026']);
    const arr = JSON.parse(result);
    expect(arr.filter((p: string) => p === '7|2026').length).toBe(1);
    expect(arr).toContain('5|2026');
  });

  it('sorts newest period first', () => {
    const result = mergeDeepPullCoverage(null, ['6|2026', '12|2025', '7|2026']);
    const arr = JSON.parse(result);
    expect(arr[0]).toBe('7|2026');
    expect(arr[1]).toBe('6|2026');
    expect(arr[2]).toBe('12|2025');
  });

  it('after merging all HISTORY_MONTHS periods isDeepPullComplete returns true', () => {
    const all = lastNPeriods('2026-07', HISTORY_MONTHS);
    const result = mergeDeepPullCoverage(null, all);
    expect(isDeepPullComplete(result, '2026-07')).toBe(true);
  });
});
