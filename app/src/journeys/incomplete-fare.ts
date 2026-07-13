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
}

export interface DetectOptions {
  /** Min completed journeys from an origin before we trust its pattern. */
  minTripsForPattern?: number; // default 3
  /** Charge must exceed usualFare by at least this £ to flag (noise floor). */
  minOverchargeGbp?: number; // default 1.0
  /** …and by at least this ratio (charged / usual). Guards small usual fares. */
  minOverchargeRatio?: number; // default 1.5
}

const DEFAULTS: Required<DetectOptions> = {
  minTripsForPattern: 3,
  minOverchargeGbp: 1.0,
  minOverchargeRatio: 1.5,
};

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
    });
  }

  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return out;
}

/** Total disputable value across candidates — for a home-screen banner. */
export function totalDisputableRefund(candidates: OverchargeCandidate[]): number {
  return round2(candidates.reduce((s, c) => s + c.estimatedRefund, 0));
}
