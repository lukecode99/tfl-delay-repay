// TfL-REFUND-AUTO-MATCH: autoMatchRefunds date+amount matching.
import { autoMatchRefunds } from '../claims/auto-match';
import type { ClaimRecord } from '../claims/db';
import type { ParsedRefund } from '../journeys/parse';

const mockListClaims = jest.fn<ClaimRecord[], []>();
const mockGetClaim = jest.fn<ClaimRecord | null, [number]>();
const mockSetClaimOutcome = jest.fn();

jest.mock('../claims/db', () => ({
  listClaims: (...args: any[]) => mockListClaims(...args),
  getClaim: (...args: any[]) => mockGetClaim(...args),
  setClaimOutcome: (...args: any[]) => mockSetClaimOutcome(...args),
}));

function claim(overrides: Partial<ClaimRecord> & { journeyId: number }): ClaimRecord {
  return {
    claimedAt: '2026-07-01T10:00:00.000Z',
    status: 'claimed',
    expectedValue: 3.00,
    paidAmount: null,
    resolvedAt: null,
    ...overrides,
  };
}

function refund(overrides: Partial<ParsedRefund>): ParsedRefund {
  return { date: '2026-07-05', credit: 3.00, rawAction: 'Delay Repay', ...overrides };
}

beforeEach(() => {
  mockListClaims.mockReset();
  mockGetClaim.mockReset();
  mockSetClaimOutcome.mockReset();
});

describe('autoMatchRefunds', () => {
  it('returns zero matched when refunds is empty', () => {
    mockListClaims.mockReturnValue([]);
    expect(autoMatchRefunds([])).toEqual({ matched: 0, corrections: [], suggestions: [] });
  });

  it('auto-writes a claimed claim matched by date + amount', () => {
    const c = claim({ journeyId: 1 });
    mockListClaims.mockReturnValue([c]);
    mockGetClaim.mockReturnValue(c);

    const result = autoMatchRefunds([refund({ date: '2026-07-08', credit: 3.00 })]);
    expect(result.matched).toBe(1);
    expect(result.suggestions).toHaveLength(0);
    expect(mockSetClaimOutcome).toHaveBeenCalledWith(1, 'paid', 3.00);
  });

  it('does not match when refund date is before claim date', () => {
    const c = claim({ journeyId: 3, claimedAt: '2026-07-10T09:00:00.000Z' });
    mockListClaims.mockReturnValue([c]);

    const result = autoMatchRefunds([refund({ date: '2026-07-09', credit: 3.00 })]);
    expect(result.matched).toBe(0);
    expect(mockSetClaimOutcome).not.toHaveBeenCalled();
  });

  it('does not match when refund date is outside 14-day window', () => {
    const c = claim({ journeyId: 4, claimedAt: '2026-07-01T00:00:00.000Z' });
    mockListClaims.mockReturnValue([c]);

    // 2026-07-16 is 15 days after 2026-07-01 — outside 14-day window
    const result = autoMatchRefunds([refund({ date: '2026-07-16', credit: 3.00 })]);
    expect(result.matched).toBe(0);
  });

  it('does not match when two claimed claims have similar amounts (ambiguous)', () => {
    const c1 = claim({ journeyId: 5, expectedValue: 3.00 });
    const c2 = claim({ journeyId: 6, expectedValue: 3.20 });
    mockListClaims.mockReturnValue([c1, c2]);

    // Both within ±£0.50 of 3.10
    const result = autoMatchRefunds([refund({ credit: 3.10 })]);
    expect(result.matched).toBe(0);
    expect(mockSetClaimOutcome).not.toHaveBeenCalled();
  });

  it('skips a match if the claim was already resolved between list and get', () => {
    const c = claim({ journeyId: 7 });
    mockListClaims.mockReturnValue([c]);
    mockGetClaim.mockReturnValue({ ...c, status: 'paid', paidAmount: 3.00 });

    const result = autoMatchRefunds([refund({ credit: 3.00 })]);
    expect(result.matched).toBe(0);
    expect(mockSetClaimOutcome).not.toHaveBeenCalled();
  });

  it('returns a correction for a bad-paid claim matched by date+amount', () => {
    const badPaid = claim({ journeyId: 8, status: 'paid', paidAmount: 0, expectedValue: 4.00 });
    mockListClaims.mockReturnValue([badPaid]);

    const result = autoMatchRefunds([refund({ credit: 4.00 })]);
    expect(result.matched).toBe(0);
    expect(result.corrections).toEqual([{ journeyId: 8, suggested: 4.00 }]);
  });

  it('routes a null-expectedValue overcharge claim to suggestions, never auto-writes', () => {
    const c = claim({ journeyId: 9, expectedValue: null });
    mockListClaims.mockReturnValue([c]);

    const result = autoMatchRefunds([refund({ date: '2026-07-05', credit: 15.00 })]);
    expect(result.matched).toBe(0);
    expect(mockSetClaimOutcome).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([{ journeyId: 9, credit: 15.00 }]);
  });

  it('delay claim and overcharge claim with same credit do not collide — separate pools', () => {
    // Delay claim: expectedValue known → auto-write pool
    const delay = claim({ journeyId: 10, expectedValue: 3.00 });
    // Overcharge claim: null expectedValue → suggestion pool
    const overcharge = claim({ journeyId: 11, expectedValue: null });
    mockListClaims.mockReturnValue([delay, overcharge]);
    mockGetClaim.mockReturnValue(delay);

    const result = autoMatchRefunds([refund({ date: '2026-07-05', credit: 3.00 })]);
    // Delay claim gets auto-written (1 candidate in its pool)
    expect(result.matched).toBe(1);
    expect(mockSetClaimOutcome).toHaveBeenCalledWith(10, 'paid', 3.00);
    // Overcharge claim goes to suggestions (1 candidate in its pool)
    expect(result.suggestions).toEqual([{ journeyId: 11, credit: 3.00 }]);
  });

  it('does not suggest an overcharge claim when refund is outside the 14-day window', () => {
    const c = claim({ journeyId: 12, expectedValue: null });
    mockListClaims.mockReturnValue([c]);

    const result = autoMatchRefunds([refund({ date: '2026-07-16', credit: 5.00 })]);
    expect(result.suggestions).toHaveLength(0);
  });
});
