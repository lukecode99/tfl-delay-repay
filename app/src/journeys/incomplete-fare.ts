// Incomplete-journey / max-fare overcharge detector (TfL-21).
//
// When you don't tap out, TfL charges the *maximum* fare for your entry
// station (an "incomplete journey" charge). If your history shows you almost
// always complete the same route — e.g. you nearly always tap out at Northolt
// on the way home — then a missing tap-out plus a fare well above your usual
// one for that origin is a disputable overcharge, refundable as the gap.
//
// This module learns each origin's regular pattern from the user's OWN
// completed journeys (no fares table needed — the truth is what they normally
// pay) and flags incomplete journeys charged materially above that. Pure and
// node-testable, like the other journeys/* modules; zero React Native imports.
//
//   node --experimental-strip-types src/journeys/test-incomplete-fare.ts

import type { ParsedJourney } from './parse';

/** Learned pattern for a single entry (origin) station. */
export interface OriginProfile {
  origin: string;
  completeTrips: number; // completed (tapped-out) journeys from this origin
  topDestination: string | null; // most frequent tap-out for this origin
  topDestinationShare: number; // 0..1 — how dominant that destination is
  usualFare: number | null; // typical £ paid (median of completed charges)
  maxSeenFare: number | null; // highest completed fare — sanity ceiling
}

// TfL claim rules (from tfl.gov.uk incomplete-journey refund page):
//  • You have up to 8 WEEKS from the journey to claim an incomplete-journey
//    max-fare refund → anything older is no longer claimable.
//  • Most incomplete-journey max fares are auto-refunded; TfL asks you to
//    WAIT AT LEAST 48 HOURS before applying, so a just-charged journey may
//    still refund itself — don't nag before then.
export const CLAIM_WINDOW_DAYS = 56; // 8 weeks
export const AUTO_REFUND_WAIT_HOURS = 48;

/** Where an overcharge sits relative to TfL's claim window. */
export type ClaimStatus =
  | 'claimable' // inside the 8-week window and past the 48h auto-refund wait
  | 'pending-auto' // <48h old — TfL may still auto-refund it; hold off
  | 'expired'; // older than 8 weeks — TfL will no longer refund

/** A flagged incomplete journey that looks like a max-fare overcharge. */
export interface OverchargeCandidate {
  journeyKey: string; // parse.journeyKey(journey)
  date: string;
  origin: string;
  likelyDestination: string | null; // inferred from the origin's regular pattern
  charged: number; // what TfL took
  usualFare: number; // what this route normally costs the user
  estimatedRefund: number; // charged − usualFare (the disputable gap)
  confidence: 'high' | 'medium' | 'low';
  reason: string; // human-readable justification for the flag
  ageDays: number | null; // age at asOf (null if asOf not supplied)
  claimStatus: ClaimStatus; // 'claimable' when actionable; see ClaimStatus
  claimDeadline: string | null; // YYYY-MM-DD — last day to claim (journey + 8wk)
}

export interface DetectOptions {
  /** Min completed journeys from an origin before we trust its pattern. */
  minTripsForPattern?: number; // default 3
  /** Charge must exceed usualFare by at least this £ to flag (noise floor). */
  minOverchargeGbp?: number; // default 1.0
  /** …and by at least this ratio (charged / usual). Guards small usual fares. */
  minOverchargeRatio?: number; // default 1.5
  /** "Today" as YYYY-MM-DD, for the 8-week claim-window maths. Production
   *  passes the device date; omit and every candidate is 'claimable' (age
   *  unknown) so nothing is hidden when the reference date is absent. */
  asOfISO?: string;
}

const DEFAULTS: Required<Omit<DetectOptions, 'asOfISO'>> = {
  minTripsForPattern: 3,
  minOverchargeGbp: 1.0,
  minOverchargeRatio: 1.5,
};

/** Whole days between two YYYY-MM-DD dates (b − a), UTC-noon to dodge DST. */
function daysBetween(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${bISO.slice(0, 10)}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Add days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Median of a numeric list (sorted copy; average of the middle two if even). */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build a per-origin profile from completed journeys. Only journeys with a
 * tap-out (`!incomplete`), a destination and a positive charge inform the
 * pattern — incomplete rows are what we're trying to judge, never evidence.
 */
export function buildOriginProfiles(journeys: ParsedJourney[]): Map<string, OriginProfile> {
  const byOrigin = new Map<string, ParsedJourney[]>();
  for (const j of journeys) {
    if (j.incomplete || !j.destination || j.charge == null || j.charge <= 0) continue;
    const list = byOrigin.get(j.origin) ?? [];
    list.push(j);
    byOrigin.set(j.origin, list);
  }

  const profiles = new Map<string, OriginProfile>();
  for (const [origin, trips] of byOrigin) {
    const destCounts = new Map<string, number>();
    for (const t of trips) destCounts.set(t.destination!, (destCounts.get(t.destination!) ?? 0) + 1);
    let topDestination: string | null = null;
    let topCount = 0;
    for (const [dest, n] of destCounts) if (n > topCount) { topCount = n; topDestination = dest; }

    // Usual fare = median of completed fares to the *top* destination when we
    // have enough of them, else median across all completed fares from origin.
    const topDestFares = trips.filter(t => t.destination === topDestination).map(t => t.charge!);
    const allFares = trips.map(t => t.charge!);
    const usualFare = median(topDestFares.length >= 3 ? topDestFares : allFares);

    profiles.set(origin, {
      origin,
      completeTrips: trips.length,
      topDestination,
      topDestinationShare: trips.length ? topCount / trips.length : 0,
      usualFare: usualFare == null ? null : round2(usualFare),
      maxSeenFare: allFares.length ? Math.max(...allFares) : null,
    });
  }
  return profiles;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Stable-ish key mirroring parse.journeyKey without importing it circularly. */
function keyOf(j: ParsedJourney): string {
  return `${j.card}|${j.date}T${j.tapInTime ?? '??'}|${j.origin}`;
}

/**
 * Scan journeys for incomplete (missing tap-out) rows that were charged
 * materially above the user's usual fare for that origin. Returns candidates
 * newest-first, each with an estimated refund and a confidence tier.
 */
export function detectOvercharges(
  journeys: ParsedJourney[],
  options: DetectOptions = {},
): OverchargeCandidate[] {
  const opt = { ...DEFAULTS, ...options };
  const profiles = buildOriginProfiles(journeys);
  const out: OverchargeCandidate[] = [];

  for (const j of journeys) {
    if (!j.incomplete) continue; // only missing tap-outs can be max-fare charges
    if (j.charge == null || j.charge <= 0) continue; // nothing charged → nothing to dispute
    const p = profiles.get(j.origin);
    if (!p || p.usualFare == null) continue; // no pattern for this origin → can't judge
    if (p.completeTrips < opt.minTripsForPattern) continue; // too little history to trust

    const overGbp = j.charge - p.usualFare;
    const ratio = p.usualFare > 0 ? j.charge / p.usualFare : Infinity;
    if (overGbp < opt.minOverchargeGbp || ratio < opt.minOverchargeRatio) continue;

    // Confidence blends how regular the route is with how much history backs it.
    const share = p.topDestinationShare;
    const trips = p.completeTrips;
    let confidence: OverchargeCandidate['confidence'] = 'low';
    if (share >= 0.7 && trips >= 8) confidence = 'high';
    else if (share >= 0.5 && trips >= 4) confidence = 'medium';

    // Claim window: deep history is pulled for pattern-learning, but only
    // overcharges still inside TfL's 8-week window are worth actioning, and
    // ones <48h old may auto-refund. Without asOf we can't age them, so they
    // stay 'claimable' (never hidden on missing reference date).
    let ageDays: number | null = null;
    let claimStatus: ClaimStatus = 'claimable';
    let claimDeadline: string | null = null;
    if (opt.asOfISO) {
      ageDays = daysBetween(j.date, opt.asOfISO);
      claimDeadline = addDays(j.date, CLAIM_WINDOW_DAYS);
      if (ageDays > CLAIM_WINDOW_DAYS) claimStatus = 'expired';
      else if (ageDays * 24 < AUTO_REFUND_WAIT_HOURS) claimStatus = 'pending-auto';
    }

    out.push({
      journeyKey: keyOf(j),
      date: j.date,
      origin: j.origin,
      likelyDestination: p.topDestination,
      charged: round2(j.charge),
      usualFare: round2(p.usualFare),
      estimatedRefund: round2(overGbp),
      confidence,
      reason:
        `No tap-out from ${j.origin}; charged £${round2(j.charge).toFixed(2)} vs your usual ` +
        `£${round2(p.usualFare).toFixed(2)}` +
        (p.topDestination ? ` to ${p.topDestination}` : '') +
        ` (${Math.round(share * 100)}% of ${trips} trips).`,
      ageDays,
      claimStatus,
      claimDeadline,
    });
  }

  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return out;
}

/** Only the overcharges still worth actioning — inside the 8-week window and
 *  past the 48h auto-refund wait. This is what the banner should push. */
export function claimableOvercharges(candidates: OverchargeCandidate[]): OverchargeCandidate[] {
  return candidates.filter(c => c.claimStatus === 'claimable');
}

/** Total disputable value across candidates — for a home-screen banner. */
export function totalDisputableRefund(candidates: OverchargeCandidate[]): number {
  return round2(candidates.reduce((s, c) => s + c.estimatedRefund, 0));
}
