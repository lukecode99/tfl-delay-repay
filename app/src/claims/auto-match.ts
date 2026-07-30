// Auto-match CSV credit rows to open claims by date proximity + amount (±£0.50).
// Requires exactly one candidate to prevent mis-matching when multiple open
// claims have similar values. Side-effects: marks matched claimed→paid.
//
// Matching rules (both must hold):
//   date: refund.date is on or after claimedAt date AND within 90 days
//   amount: |expectedValue - credit| ≤ £0.50 when expectedValue is known;
//           any credit amount when expectedValue is null (overcharge claims)
//
// Returns { matched, corrections }: matched = claims written; corrections =
// claims already marked paid with a bad amount (0 or null) where a refund
// matches. Corrections are returned, never written — caller decides.
import type { ParsedRefund } from '../journeys/parse';
import { getClaim, listClaims, setClaimOutcome } from './db';

export interface AutoMatchResult {
  matched: number;
  corrections: Array<{ journeyId: number; suggested: number }>;
}

const MATCH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function inWindow(refundDate: string, claimedAt: string): boolean {
  const refund = new Date(refundDate).getTime();
  const claimed = new Date(claimedAt.slice(0, 10)).getTime();
  return refund >= claimed && (refund - claimed) <= MATCH_WINDOW_MS;
}

export function autoMatchRefunds(refunds: ParsedRefund[]): AutoMatchResult {
  if (!refunds.length) return { matched: 0, corrections: [] };

  const claimedClaims = listClaims().filter(c => c.status === 'claimed');
  let matched = 0;
  for (const refund of refunds) {
    const candidates = claimedClaims.filter(c => {
      if (!inWindow(refund.date, c.claimedAt)) return false;
      if (c.expectedValue != null) return Math.abs(c.expectedValue - refund.credit) <= 0.50;
      return true; // overcharge claim (null expectedValue): date match is sufficient
    });
    if (candidates.length === 1) {
      // Re-fetch to guard against double-match within the same import batch
      const current = getClaim(candidates[0].journeyId);
      if (current?.status === 'claimed') {
        setClaimOutcome(candidates[0].journeyId, 'paid', refund.credit);
        matched++;
      }
    }
  }

  // Paid claims with a missing or zero amount and a known expected value —
  // return as correction candidates. Never written here: paidAmount=0 came
  // from a blank prompt (the PAID-ZERO bug) and we won't silently overwrite
  // an already-resolved claim without the user seeing it.
  const badPaid = listClaims().filter(
    c => c.status === 'paid' && (c.paidAmount === 0 || c.paidAmount === null) && c.expectedValue != null,
  );
  const corrections: Array<{ journeyId: number; suggested: number }> = [];
  for (const refund of refunds) {
    const candidates = badPaid.filter(
      c => inWindow(refund.date, c.claimedAt) && Math.abs((c.expectedValue as number) - refund.credit) <= 0.50,
    );
    if (candidates.length === 1) {
      corrections.push({ journeyId: candidates[0].journeyId, suggested: refund.credit });
    }
  }

  return { matched, corrections };
}
