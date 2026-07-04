// Lifetime claim totals for the home screen (TfL-7). Pure — node-testable.

export interface ClaimForTotals {
  status: 'claimed' | 'paid' | 'rejected';
  expectedValue: number | null;
  paidAmount: number | null;
}

export interface ClaimTotals {
  claimedCount: number; // every claim ever filed, whatever happened next
  claimedValue: number; // sum of expected values at claim time
  paidCount: number;
  paidValue: number; // sum of amounts actually received
  rejectedCount: number;
  openCount: number; // still awaiting a TfL decision
}

export function claimTotals(claims: ClaimForTotals[]): ClaimTotals {
  const t: ClaimTotals = { claimedCount: 0, claimedValue: 0, paidCount: 0, paidValue: 0, rejectedCount: 0, openCount: 0 };
  for (const c of claims) {
    t.claimedCount++;
    t.claimedValue += c.expectedValue ?? 0;
    if (c.status === 'paid') {
      t.paidCount++;
      // A paid claim with no recorded amount still counts toward paidCount;
      // fall back to the expected value so the total isn't silently short.
      t.paidValue += c.paidAmount ?? c.expectedValue ?? 0;
    } else if (c.status === 'rejected') t.rejectedCount++;
    else t.openCount++;
  }
  return t;
}
