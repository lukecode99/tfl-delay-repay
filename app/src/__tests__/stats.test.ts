// TfL-RECEIVED-UNKNOWN: claimTotals excludes unknown-paid from paidValue.
import { claimTotals } from '../claims/stats';
import type { ClaimForTotals } from '../claims/stats';

function c(status: ClaimForTotals['status'], expectedValue: number | null, paidAmount: number | null): ClaimForTotals {
  return { status, expectedValue, paidAmount };
}

describe('claimTotals', () => {
  it('returns zero totals for empty list', () => {
    const t = claimTotals([]);
    expect(t).toEqual({
      claimedCount: 0, claimedValue: 0, paidCount: 0, paidValue: 0,
      unknownPaidCount: 0, rejectedCount: 0, openCount: 0,
    });
  });

  it('counts a paid claim with a known paidAmount in paidValue', () => {
    const t = claimTotals([c('paid', 3.00, 2.80)]);
    expect(t.paidValue).toBeCloseTo(2.80);
    expect(t.unknownPaidCount).toBe(0);
  });

  it('falls back to expectedValue when paidAmount is null', () => {
    const t = claimTotals([c('paid', 3.00, null)]);
    expect(t.paidValue).toBeCloseTo(3.00);
    expect(t.unknownPaidCount).toBe(0);
  });

  it('excludes from paidValue when both paidAmount and expectedValue are null', () => {
    const t = claimTotals([c('paid', null, null)]);
    expect(t.paidValue).toBe(0);
    expect(t.paidCount).toBe(1);
    expect(t.unknownPaidCount).toBe(1);
  });

  it('does not include zero paidAmount in unknownPaidCount (zero is a known amount)', () => {
    // paidAmount=0 is a valid (if suspicious) recorded amount, not "unknown"
    const t = claimTotals([c('paid', null, 0)]);
    expect(t.paidValue).toBe(0);
    expect(t.unknownPaidCount).toBe(0);
  });

  it('sums correctly across mixed claims', () => {
    const claims: ClaimForTotals[] = [
      c('paid', 3.00, 2.80),   // paidValue += 2.80
      c('paid', 1.50, null),   // paidValue += 1.50 (expectedValue fallback)
      c('paid', null, null),   // unknownPaidCount++
      c('claimed', 2.00, null),
      c('rejected', 1.00, null),
    ];
    const t = claimTotals(claims);
    expect(t.claimedCount).toBe(5);
    expect(t.paidCount).toBe(3);
    expect(t.paidValue).toBeCloseTo(4.30);
    expect(t.unknownPaidCount).toBe(1);
    expect(t.rejectedCount).toBe(1);
    expect(t.openCount).toBe(1);
  });
});
