// Auto-match CSV Delay Repay credit rows to open claims by amount (±£0.50).
// Requires exactly one candidate to prevent mis-matching when multiple open
// claims have similar values. Side-effects: marks matched claims as 'paid'.
import type { ParsedRefund } from '../journeys/parse';
import { getClaim, listClaims, setClaimOutcome } from './db';

export function autoMatchRefunds(refunds: ParsedRefund[]): number {
  if (!refunds.length) return 0;
  const openClaims = listClaims().filter(c => c.status === 'claimed' && c.expectedValue != null);
  let matched = 0;
  for (const refund of refunds) {
    const candidates = openClaims.filter(
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
  return matched;
}
