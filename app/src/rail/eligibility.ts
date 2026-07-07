// DR15 (Delay Repay 15) eligibility engine for National Rail.
//
// DR15 applies to Avanti West Coast, Southern, and other TOCs with the
// scheme. Delay is measured from the scheduled arrival at destination.
//
// Bands (delay at destination vs scheduled arrival):
//   < 15 min  → not eligible
//   15–29 min → 25 % of single fare
//   30–59 min → 50 % of single fare
//   60–119 min → 100 % of single fare
//   120+ min  → 100 % of return fare (≈ 2× single for DR purposes)

export type Dr15Band = 'none' | 'quarter' | 'half' | 'full-single' | 'full-return';

export interface RailEligibility {
  band: Dr15Band;
  delayMinutes: number | null;
  refundEstimate: number | null;
  isEligible: boolean;
  /** Human-readable band description for display. */
  label: string;
}

export function bandFor(delayMinutes: number): Dr15Band {
  if (delayMinutes < 15) return 'none';
  if (delayMinutes < 30) return 'quarter';
  if (delayMinutes < 60) return 'half';
  if (delayMinutes < 120) return 'full-single';
  return 'full-return';
}

export function bandLabel(band: Dr15Band): string {
  switch (band) {
    case 'none': return 'Not eligible (< 15 min)';
    case 'quarter': return '25 % refund (15–29 min)';
    case 'half': return '50 % refund (30–59 min)';
    case 'full-single': return '100 % single fare (60–119 min)';
    case 'full-return': return '100 % return fare (120+ min)';
  }
}

/** Estimate refund value given a band and a single fare (in pounds). */
export function estimateRefund(band: Dr15Band, singleFare: number | null): number | null {
  if (band === 'none' || singleFare == null || singleFare <= 0) return null;
  switch (band) {
    case 'quarter': return Math.round(singleFare * 0.25 * 100) / 100;
    case 'half': return Math.round(singleFare * 0.5 * 100) / 100;
    case 'full-single': return Math.round(singleFare * 100) / 100;
    case 'full-return': return Math.round(singleFare * 2 * 100) / 100;
  }
}

export function assessRailJourney(opts: {
  delayMinutes: number | null;
  singleFare: number | null;
}): RailEligibility {
  const { delayMinutes, singleFare } = opts;
  if (delayMinutes == null) {
    return { band: 'none', delayMinutes: null, refundEstimate: null, isEligible: false, label: 'Delay unknown — enter manually' };
  }
  const band = bandFor(delayMinutes);
  return {
    band,
    delayMinutes,
    refundEstimate: estimateRefund(band, singleFare),
    isEligible: band !== 'none',
    label: bandLabel(band),
  };
}

/** Parse "HH:MM" → total minutes since midnight. Returns null on bad input. */
export function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Compute delay in minutes between scheduled and actual arrival.
 * Handles overnight services (actual < scheduled by more than 6 hours ≈ ran
 * past midnight → add 1440).
 */
export function computeDelay(scheduledArrive: string, actualArrive: string): number | null {
  const sched = hmToMinutes(scheduledArrive);
  const actual = hmToMinutes(actualArrive);
  if (sched == null || actual == null) return null;
  let diff = actual - sched;
  if (diff < -360) diff += 1440; // crossed midnight
  return diff;
}
