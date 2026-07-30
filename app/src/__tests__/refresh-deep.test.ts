// Tests for TfL-REFRESH-DEEP: deep-pull one-time gate and period selection.
// TfL-MODE-SWITCH: per-mode deep pull key.
// TfL-DEEPPULL-PROOF: period-level coverage marker helpers.
import {
  periodsForRefresh,
  pendingDeepPullPeriods,
  lastNPeriods,
  HISTORY_MONTHS,
  PASS_PERIODS,
  DEEP_PULL_META_KEY,
  deepPullMetaKeyFor,
  deepPullCoveredPeriods,
  isDeepPullComplete,
  mergeDeepPullCoverage,
} from '../journeys/direct-csv';
import { isJourneyCsv } from '../journeys/parse';

describe('periodsForRefresh', () => {
  it('returns PASS_PERIODS newest months when nothing is covered', () => {
    const periods = periodsForRefresh('2026-07', null);
    expect(periods).toHaveLength(PASS_PERIODS);
    expect(periods[0]).toBe('7|2026');
    expect(periods[1]).toBe('6|2026');
  });

  it('returns routine window when deep pull is complete', () => {
    const full = JSON.stringify(lastNPeriods('2026-07', HISTORY_MONTHS));
    const periods = periodsForRefresh('2026-07', full);
    expect(periods).toHaveLength(PASS_PERIODS);
    expect(periods[0]).toBe('7|2026');
    expect(periods[1]).toBe('6|2026');
  });

  it('skips already-covered periods and returns next uncovered', () => {
    const partial = JSON.stringify(['7|2026', '6|2026']);
    const periods = periodsForRefresh('2026-07', partial);
    expect(periods[0]).toBe('5|2026');
    expect(periods[1]).toBe('4|2026');
  });

  it('handles year boundary correctly in routine mode', () => {
    const full = JSON.stringify(lastNPeriods('2026-01', HISTORY_MONTHS));
    const periods = periodsForRefresh('2026-01', full);
    expect(periods[0]).toBe('1|2026');
    expect(periods[1]).toBe('12|2025');
  });

  it('DEEP_PULL_META_KEY is a non-empty string', () => {
    expect(typeof DEEP_PULL_META_KEY).toBe('string');
    expect(DEEP_PULL_META_KEY.length).toBeGreaterThan(0);
  });
});

describe('pendingDeepPullPeriods', () => {
  it('returns HISTORY_MONTHS when nothing is covered', () => {
    expect(pendingDeepPullPeriods('2026-07', null)).toBe(HISTORY_MONTHS);
  });

  it('returns 0 when complete', () => {
    const full = JSON.stringify(lastNPeriods('2026-07', HISTORY_MONTHS));
    expect(pendingDeepPullPeriods('2026-07', full)).toBe(0);
  });

  it('returns remaining count after partial coverage', () => {
    const partial = JSON.stringify(['7|2026', '6|2026']);
    expect(pendingDeepPullPeriods('2026-07', partial)).toBe(HISTORY_MONTHS - 2);
  });

  it('backfill completes in at most ceil(HISTORY_MONTHS / PASS_PERIODS) passes', () => {
    // Verifies the 144-sequential-fetch problem cannot recur: each pass fetches
    // at most PASS_PERIODS periods, so job count = cards × PASS_PERIODS × 2.
    let meta: string | null = null;
    const nowISO = '2026-07';
    let passes = 0;
    const maxPasses = Math.ceil(HISTORY_MONTHS / PASS_PERIODS) + 1; // +1 for the 2-month routine window
    while (!isDeepPullComplete(meta, nowISO)) {
      const periods = periodsForRefresh(nowISO, meta);
      expect(periods.length).toBeLessThanOrEqual(PASS_PERIODS);
      meta = mergeDeepPullCoverage(meta, periods);
      passes++;
      expect(passes).toBeLessThanOrEqual(maxPasses);
    }
    expect(isDeepPullComplete(meta, nowISO)).toBe(true);
    expect(periodsForRefresh(nowISO, meta)).toHaveLength(PASS_PERIODS);
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

  it('remains complete on month rollover — July full pull proves August window', () => {
    // The routine 2-month window (Aug+Jul) is excluded from the completeness
    // check, so a July full pull still satisfies August's history requirement.
    const julFull = JSON.stringify(lastNPeriods('2026-07', HISTORY_MONTHS));
    expect(isDeepPullComplete(julFull, '2026-08')).toBe(true);
  });

  it('returns false when marker is too old to cover the history window', () => {
    // A marker from March 2026 is missing May and April 2026, which are
    // within the history window (slice(2)) for July 2026.
    const oldFull = JSON.stringify(lastNPeriods('2026-03', HISTORY_MONTHS));
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

describe('isJourneyCsv', () => {
  const JOURNEY_HEADER = 'Date,Start Time,End Time,Journey/Action,Charge,Credit,Balance,Note';
  const JOURNEY_ROW = '30-Jul-2026,08:00,08:32,"Waterloo [London Underground] to Bank [London Underground]",£1.75,,£10.00,';

  it('accepts a full journey CSV', () => {
    expect(isJourneyCsv(`${JOURNEY_HEADER}\n${JOURNEY_ROW}`)).toBe(true);
  });

  it('accepts a header-only month (0 journey rows)', () => {
    // Months before the account existed return a valid header with no data rows.
    // These must count as covered — they prove TfL returned a statement.
    expect(isJourneyCsv(JOURNEY_HEADER)).toBe(true);
  });

  it('accepts BOM-prefixed journey CSV', () => {
    expect(isJourneyCsv(`﻿${JOURNEY_HEADER}\n${JOURNEY_ROW}`)).toBe(true);
  });

  it('rejects an HTML body (TfL 404 or login redirect)', () => {
    expect(isJourneyCsv('<!DOCTYPE html><html><head></head><body></body></html>')).toBe(false);
  });

  it('rejects a billing CSV — has Date but no Journey column', () => {
    const billingHeader = 'Date,Description,Amount,Balance';
    const billingRow = '30-Jul-2026,DIRECT DEBIT,£15.00,£0.00';
    expect(isJourneyCsv(`${billingHeader}\n${billingRow}`)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isJourneyCsv('')).toBe(false);
  });

  it('rejects a plain text body with no commas', () => {
    expect(isJourneyCsv('Access denied')).toBe(false);
  });
});
