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
  paidValue: number; // sum of amounts actually received (excludes unknownPaidCount entries)
  unknownPaidCount: number; // paid claims where neither paidAmount nor expectedValue is known
  rejectedCount: number;
  openCount: number; // still awaiting a TfL decision
}

export function claimTotals(claims: ClaimForTotals[]): ClaimTotals {
  const t: ClaimTotals = { claimedCount: 0, claimedValue: 0, paidCount: 0, paidValue: 0, unknownPaidCount: 0, rejectedCount: 0, openCount: 0 };
  for (const c of claims) {
    t.claimedCount++;
    t.claimedValue += c.expectedValue ?? 0;
    if (c.status === 'paid') {
      t.paidCount++;
      if (c.paidAmount != null) {
        t.paidValue += c.paidAmount;
      } else if (c.expectedValue != null) {
        t.paidValue += c.expectedValue;
      } else {
        // Both null: no reliable figure — exclude from total rather than silently add 0.
        t.unknownPaidCount++;
      }
    } else if (c.status === 'rejected') t.rejectedCount++;
    else t.openCount++;
  }
  return t;
}
