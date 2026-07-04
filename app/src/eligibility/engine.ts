// Delay-eligibility engine (TfL-4). Pure module: all I/O (planner fetch,
// ledger queries, fares) is injected, so the whole thing unit-tests with
// fixtures and the UI wires real adapters in TfL-5.
import type { Fare } from '../data';
import type { ParsedJourney } from '../journeys/parse';
import type { PairTiming } from './planner';

export type Confidence = 'high' | 'medium' | 'low';

export interface LedgerStatus {
  ts: string; // ISO UTC poll time
  line: string; // TfL line id
  statusSeverity: number; // 10 = Good Service, lower = worse
  statusDescription: string;
  reason: string | null;
}

export interface LedgerEvidence {
  coverage: number; // polls of these lines inside the window (0 = collector gap)
  statuses: LedgerStatus[]; // disrupted rows only (severity != 10)
}

/** Query the TfL-1 disruption ledger for the given lines and UTC window. */
export type DisruptionLookup = (lines: string[], fromISO: string, toISO: string) => LedgerEvidence;

export type AssessmentStatus = 'eligible' | 'not-eligible' | 'not-assessable';
export type ReasonCode =
  | 'incomplete' // missing tap-out — flagged by TfL-3, claimable later via TfL-10 flow
  | 'unresolved-station' // CSV station name didn't match the bundled dataset
  | 'no-timing' // journey planner couldn't route the pair
  | 'under-threshold'
  | 'no-disruption' // ledger covered the window and showed the lines healthy
  | 'ok';

export interface Assessment {
  status: AssessmentStatus;
  reasonCode: ReasonCode;
  actualMinutes?: number;
  expectedMinutes?: number;
  overageMinutes?: number;
  thresholdMinutes?: number;
  confidence?: Confidence;
  disruption?: { line: string; description: string; reason: string | null; ts: string };
  /** £; CSV charge when present, else zone-matrix estimate, else null. */
  refundValue: number | null;
  plausibleLines: string[];
}

// --- Europe/London → UTC ---------------------------------------------------
// CSV dates/times are London local; the ledger is UTC. BST runs from 01:00 UTC
// on the last Sunday of March to 01:00 UTC on the last Sunday of October.

function lastSundayUtc(year: number, month0: number, hourUtc: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0));
  const day = lastDay.getUTCDate() - lastDay.getUTCDay();
  return Date.UTC(year, month0, day, hourUtc);
}

/** "YYYY-MM-DD" + "HH:MM" London local → epoch ms UTC. */
export function londonToUtcMs(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const bstStart = lastSundayUtc(y, 2, 1); // last Sunday of March, 01:00 UTC
  const bstEnd = lastSundayUtc(y, 9, 1); // last Sunday of October, 01:00 UTC
  const inBst = naive >= bstStart + 3600_000 && naive < bstEnd + 3600_000;
  return inBst ? naive - 3600_000 : naive;
}

const iso = (ms: number) => new Date(ms).toISOString();

// --- Thresholds --------------------------------------------------------------
// TfL customer charter: refund for 15+ min delays on Tube/DLR, 30+ min on
// Overground/Elizabeth line. Threshold follows the fastest route's modes —
// the route the rider most plausibly took.

const SLOW_MODES = new Set(['overground', 'elizabeth-line']);

export function thresholdForTiming(timing: PairTiming): number {
  const fastest = timing.routes[0];
  return fastest.modes.some(m => SLOW_MODES.has(m)) ? 30 : 15;
}

// --- Fares -------------------------------------------------------------------
// Peak PAYG charging: 06:30–09:30 and 16:00–19:00, Monday–Friday.

export function isPeak(date: string, time: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const [hh, mm] = time.split(':').map(Number);
  const mins = hh * 60 + mm;
  return (mins >= 390 && mins < 570) || (mins >= 960 && mins < 1140);
}

// --- Assessment ---------------------------------------------------------------

const DURING_LEAD_MS = 45 * 60_000; // disruption starting shortly before tap-in still bites
const NEAR_MS = 3 * 3600_000; // same service period
const MINOR_DELAYS = 9;

export interface AssessInput {
  journey: ParsedJourney;
  timing: PairTiming | null; // from planner.expectedTiming (null = unroutable)
  lookup: DisruptionLookup;
  fareEstimate?: Fare | null; // zone-matrix estimate for the pair, if any
}

export function assessJourney({ journey, timing, lookup, fareEstimate }: AssessInput): Assessment {
  const plausibleLines = timing?.plausibleLines ?? [];

  const refundValue =
    journey.charge ??
    (fareEstimate ? (isPeak(journey.date, journey.tapInTime ?? '12:00') ? fareEstimate.peak : fareEstimate.offPeak) : null);

  if (journey.incomplete || !journey.tapInTime || !journey.tapOutTime || !journey.destination) {
    return { status: 'not-assessable', reasonCode: 'incomplete', refundValue, plausibleLines };
  }
  if (!timing) {
    return { status: 'not-assessable', reasonCode: 'no-timing', refundValue, plausibleLines };
  }

  const tapInMs = londonToUtcMs(journey.date, journey.tapInTime);
  let tapOutMs = londonToUtcMs(journey.date, journey.tapOutTime);
  if (tapOutMs < tapInMs) tapOutMs += 24 * 3600_000; // journey past midnight

  const actualMinutes = Math.round((tapOutMs - tapInMs) / 60_000);
  const expectedMinutes = timing.expectedMinutes;
  const overageMinutes = actualMinutes - expectedMinutes;
  const thresholdMinutes = thresholdForTiming(timing);
  const base = { actualMinutes, expectedMinutes, overageMinutes, thresholdMinutes, refundValue, plausibleLines };

  if (overageMinutes < thresholdMinutes) {
    return { status: 'not-eligible', reasonCode: 'under-threshold', ...base };
  }

  // Ledger corroboration: a "during" window (with lead time) decides coverage;
  // a wider "near" window catches disruption logged just outside it.
  const during = lookup(plausibleLines, iso(tapInMs - DURING_LEAD_MS), iso(tapOutMs));
  const near = lookup(plausibleLines, iso(tapInMs - NEAR_MS), iso(tapOutMs + NEAR_MS));

  const worst = (rows: LedgerStatus[]) =>
    rows.length ? rows.reduce((a, b) => (b.statusSeverity < a.statusSeverity ? b : a)) : null;
  const duringWorst = worst(during.statuses);
  const nearWorst = worst(near.statuses);

  let confidence: Confidence | null = null;
  if (duringWorst && duringWorst.statusSeverity < MINOR_DELAYS) confidence = 'high';
  else if (duringWorst || (nearWorst && nearWorst.statusSeverity < MINOR_DELAYS)) confidence = 'medium';
  else if (nearWorst) confidence = 'low';
  else if (during.coverage === 0) confidence = 'low'; // collector gap — can't corroborate, can't refute

  if (!confidence) {
    // Collector was watching and the plausible lines were healthy all window.
    return { status: 'not-eligible', reasonCode: 'no-disruption', ...base };
  }

  const evidence = duringWorst ?? nearWorst;
  return {
    status: 'eligible',
    reasonCode: 'ok',
    confidence,
    disruption: evidence
      ? { line: evidence.line, description: evidence.statusDescription, reason: evidence.reason, ts: evidence.ts }
      : undefined,
    ...base,
  };
}
