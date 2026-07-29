// Auto-match CSV Delay Repay credit rows to open claims by amount (±£0.50).
// Requires exactly one candidate to prevent mis-matching when multiple open
// claims have similar values. Side-effects: marks matched claimed→paid.
//
// Returns { matched, corrections }: matched = claims written; corrections =
// claims already marked paid with a bad amount (0 or null) where a refund
// credit matches the expected value. Corrections are returned, never written
// — the caller decides how to surface them (audit log, UI prompt, etc.).
import type { ParsedRefund } from '../journeys/parse';
import { getClaim, listClaims, setClaimOutcome } from './db';

export interface AutoMatchResult {
  matched: number;
  corrections: Array<{ journeyId: number; suggested: number }>;
}

export function autoMatchRefunds(refunds: ParsedRefund[]): AutoMatchResult {
  if (!refunds.length) return { matched: 0, corrections: [] };

  // Claimed claims with a known expected value — auto-write.
  const claimedClaims = listClaims().filter(c => c.status === 'claimed' && c.expectedValue != null);
  let matched = 0;
  for (const refund of refunds) {
    const candidates = claimedClaims.filter(
      c => Math.abs((c.expectedValue as number) - refund.credit) <= 0.50,
    );
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
      c => Math.abs((c.expectedValue as number) - refund.credit) <= 0.50,
    );
    if (candidates.length === 1) {
      corrections.push({ journeyId: candidates[0].journeyId, suggested: refund.credit });
    }
  }

  return { matched, corrections };
}
