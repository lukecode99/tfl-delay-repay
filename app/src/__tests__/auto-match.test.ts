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
  return { date: '2026-07-15', credit: 3.00, rawAction: 'Delay Repay', ...overrides };
}

beforeEach(() => {
  mockListClaims.mockReset();
  mockGetClaim.mockReset();
  mockSetClaimOutcome.mockReset();
});

describe('autoMatchRefunds', () => {
  it('returns zero matched when refunds is empty', () => {
    mockListClaims.mockReturnValue([]);
    expect(autoMatchRefunds([])).toEqual({ matched: 0, corrections: [] });
  });

  it('matches a claimed claim by date + amount', () => {
    const c = claim({ journeyId: 1 });
    mockListClaims.mockReturnValue([c]);
    mockGetClaim.mockReturnValue(c);

    const result = autoMatchRefunds([refund({ date: '2026-07-15', credit: 3.00 })]);
    expect(result.matched).toBe(1);
    expect(mockSetClaimOutcome).toHaveBeenCalledWith(1, 'paid', 3.00);
  });

  it('matches a null-expectedValue overcharge claim within the date window', () => {
    const c = claim({ journeyId: 2, expectedValue: null });
    mockListClaims.mockReturnValue([c]);
    mockGetClaim.mockReturnValue(c);

    const result = autoMatchRefunds([refund({ date: '2026-07-20', credit: 5.50 })]);
    expect(result.matched).toBe(1);
    expect(mockSetClaimOutcome).toHaveBeenCalledWith(2, 'paid', 5.50);
  });

  it('does not match when refund date is before claim date', () => {
    const c = claim({ journeyId: 3, claimedAt: '2026-07-10T09:00:00.000Z' });
    mockListClaims.mockReturnValue([c]);

    const result = autoMatchRefunds([refund({ date: '2026-07-09', credit: 3.00 })]);
    expect(result.matched).toBe(0);
    expect(mockSetClaimOutcome).not.toHaveBeenCalled();
  });

  it('does not match when refund date is outside 90-day window', () => {
    const c = claim({ journeyId: 4, claimedAt: '2026-01-01T00:00:00.000Z' });
    mockListClaims.mockReturnValue([c]);

    // 2026-07-01 is 181 days after 2026-01-01 — outside 90-day window
    const result = autoMatchRefunds([refund({ date: '2026-07-01', credit: 3.00 })]);
    expect(result.matched).toBe(0);
  });

  it('does not match when two candidates have similar amounts (ambiguous)', () => {
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
    // Simulate concurrent resolution — getClaim returns paid status
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
});
