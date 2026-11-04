// Match stored refunds back to the journeys that earned them, so a refund
// claimed OUTSIDE the app (e.g. on tfl.gov.uk) still tags its journey as
// Received. Pure + node-testable (see test-refund-match.ts).
//
// The in-app auto-matcher (claims/auto-match.ts) only links a refund to a
// claim the user filed in-app. This covers the other path: the refund row
// exists on the statement but there is no in-app claim to hang it on.
//
// Discipline mirrors auto-match: corroborate on card + amount, bound by a date
// window, and require EXACTLY ONE candidate. Where a refund could belong to
// more than one journey (common for same-fare commutes) we tag none rather
// than mislabel a row — "no data beats dodgy data". Such refunds still count
// in the home Received total; they just don't colour a journey.

export interface RefundLike {
  date: string; // ISO date the refund was credited
  amount: number; // credit value
  card?: string | null;
}

export interface JourneyLike {
  id: number;
  date: string; // ISO date of the journey
  charge?: number | null; // fare paid — a full/half of this is what gets refunded
  card?: string | null;
}

// Refund posts AFTER the delayed journey. TfL pays within a few working days;
// statements can lag, so allow a generous-but-bounded window.
const WINDOW_DAYS = 21;
const AMOUNT_TOLERANCE = 0.50;

function dayDiff(laterISO: string, earlierISO: string): number {
  const a = new Date(laterISO.slice(0, 10)).getTime();
  const b = new Date(earlierISO.slice(0, 10)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((a - b) / 86400000);
}

function sameCard(a?: string | null, b?: string | null): boolean {
  // Only discriminate when BOTH cards are known and non-placeholder; otherwise
  // don't exclude on card (older rows / 'unknown' default must still match).
  if (!a || !b || a === 'unknown' || b === 'unknown') return true;
  return a === b;
}

function amountCorroborates(refund: number, charge?: number | null): boolean {
  if (charge == null) return false; // no fare to corroborate against — don't guess
  const c = Math.abs(charge);
  // Delay Repay refunds a full single fare (30+ min) or half (15–29 min).
  return Math.abs(refund - c) <= AMOUNT_TOLERANCE || Math.abs(refund - c / 2) <= AMOUNT_TOLERANCE;
}

/**
 * Returns the set of journey ids that a stored refund uniquely matches.
 * A journey is included only if some refund has it as its sole candidate.
 */
export function matchRefundsToJourneys(refunds: RefundLike[], journeys: JourneyLike[]): Set<number> {
  const received = new Set<number>();
  if (!refunds.length || !journeys.length) return received;

  for (const refund of refunds) {
    const candidates = journeys.filter(j => {
      const d = dayDiff(refund.date, j.date);
      if (Number.isNaN(d) || d < 0 || d > WINDOW_DAYS) return false; // journey must precede refund, within window
      if (!sameCard(refund.card, j.card)) return false;
      return amountCorroborates(refund.amount, j.charge);
    });
    if (candidates.length === 1) received.add(candidates[0].id);
  }
  return received;
}
