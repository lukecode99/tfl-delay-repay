// Pure formatter for the Line Status Board — no React Native imports,
// node-testable. Reuses disruption-format helpers for time labels.
// Caller passes lineCatalog (ALL_LINES from push-slots), snapshot, yourLineIds,
// journeys, and now so this module has zero side-effects.
import type { LedgerSnapshot, DisruptionSpan, CoverageRange } from '../eligibility/ledger-json';
import { formatElapsed } from '../notifications/disruption-format';

// --- Public interfaces ---

export interface LineCatalogEntry {
  id: string;
  name: string;
  color: string;
}

/** Minimal journey data needed for overlap counting. */
export interface OverlapJourney {
  date: string;       // YYYY-MM-DD
  tapInTime: string | null; // HH:MM
}

export interface TimelineSeg {
  /** TfL severity value (10 = good service, lower = worse). -1 = no data. */
  severity: number;
}

export interface ActiveSpanSummary {
  from: string;         // ISO UTC (for passing to formatDisruptionAlert if needed)
  sinceLabel: string;   // "07:42" or "since Mon 07:42" (>24 h)
  elapsedShort: string; // "32 min" / "1 h 19 min" (no "ago") for the board row
  description: string;
  reason: string | null;
}

export interface StatusLineRow {
  lineId: string;
  lineName: string;
  lineColor: string;
  severity: number;     // 10 = good, lower = worse
  description: string;  // "Good service" | "No live data" | span.description
  hasLiveData: boolean;
  activeSpan: ActiveSpanSummary | null;
  journeyOverlapCount: number; // today's journeys whose tap-in overlaps the active span
  todayTimeline: TimelineSeg[];
  isYourLine: boolean;
}

export interface StatusBoard {
  yourLines: StatusLineRow[];
  otherLines: StatusLineRow[];
  generatedAt: string;
  hasAnyLiveData: boolean;
}

// --- Internal helpers ---

function londonHHMM(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

function londonDow(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
  }).format(ms);
}

/** YYYY-MM-DD for a moment in London local time. */
function londonDateStr(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** "HH:MM" → minutes since midnight (for range comparison). */
function hhmmToMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Short elapsed: "32 min" / "1 h 19 min" (no "ago") for board labels. */
export function formatElapsedShort(startMs: number, nowMs: number): string {
  const full = formatElapsed(startMs, nowMs);
  return full.replace(/ ago$/, '');
}

/** "since HH:MM" or "since ddd HH:MM" for start-time labels. */
export function formatSinceLabel(startMs: number, nowMs: number): string {
  const over24h = nowMs - startMs >= 24 * 60 * 60 * 1000;
  return over24h
    ? `since ${londonDow(startMs)} ${londonHHMM(startMs)}`
    : londonHHMM(startMs);
}

/** True if the collector has run within `windowMs` of now. */
export function hasCoverage(coverage: CoverageRange[], now: Date, windowMs = 60 * 60 * 1000): boolean {
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  return coverage.some(r => r.to >= cutoff);
}

/** A span counts as "active" if it overlaps the last 30 minutes. */
function spanIsActive(span: DisruptionSpan, now: Date): boolean {
  const thirtyMinAgoISO = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  return span.from <= now.toISOString() && span.to >= thirtyMinAgoISO;
}

/** Worst (lowest) severity active span for a line, or null. */
export function worstActiveSpan(
  spans: DisruptionSpan[],
  lineId: string,
  now: Date,
): DisruptionSpan | null {
  const active = spans.filter(s => s.line === lineId && spanIsActive(s, now));
  if (!active.length) return null;
  return active.reduce((worst, s) => s.severity < worst.severity ? s : worst);
}

/**
 * Count today's journeys whose tap-in time overlaps a disruption span.
 * Uses date + time approximation — line is unknown from stored journey data.
 */
export function countJourneyOverlaps(
  span: DisruptionSpan,
  journeys: OverlapJourney[],
  now: Date,
): number {
  const todayDate = londonDateStr(now.getTime());
  const startMs = new Date(span.from).getTime();
  const endMs = new Date(span.to).getTime();
  const spanFromHHMM = londonHHMM(startMs);
  const spanToHHMM = londonHHMM(endMs);
  const spanFromMins = hhmmToMins(spanFromHHMM);
  const spanToMins = hhmmToMins(spanToHHMM);

  return journeys.filter(j => {
    if (j.date !== todayDate || !j.tapInTime) return false;
    const tapMins = hhmmToMins(j.tapInTime);
    return tapMins >= spanFromMins && tapMins <= spanToMins;
  }).length;
}

/**
 * Build a 12-segment timeline from 05:00 London local time to now.
 * Each segment's severity is the worst span during that interval, or -1 if
 * coverage is absent for that slice.
 */
export function buildTimeline(
  spans: DisruptionSpan[],
  coverage: CoverageRange[],
  lineId: string,
  now: Date,
  segCount = 12,
): TimelineSeg[] {
  // Find the UTC ms that corresponds to 05:00 in London today.
  // London is UTC+0 (GMT) or UTC+1 (BST); probe both offsets.
  const todayDate = londonDateStr(now.getTime());
  let startOfWindow = 0;
  for (const offsetH of [0, 1]) {
    const candidate = new Date(`${todayDate}T05:00:00.000Z`).getTime() - offsetH * 3_600_000;
    if (londonHHMM(candidate) === '05:00') { startOfWindow = candidate; break; }
  }

  const nowMs = now.getTime();
  const windowMs = nowMs - startOfWindow;
  if (windowMs <= 0) return Array(segCount).fill({ severity: -1 });

  const segMs = windowMs / segCount;
  const lineSpans = spans.filter(s => s.line === lineId);

  return Array.from({ length: segCount }, (_, i) => {
    const segFrom = new Date(startOfWindow + i * segMs).toISOString();
    const segTo = new Date(startOfWindow + (i + 1) * segMs).toISOString();

    // Check coverage — if no polls in this slice, mark as no-data
    const covered = coverage.some(r => r.from <= segTo && r.to >= segFrom);
    if (!covered) return { severity: -1 };

    // Find worst (lowest) severity span overlapping this slice
    const worst = lineSpans
      .filter(s => s.from <= segTo && s.to >= segFrom)
      .reduce<number | null>((min, s) => min === null || s.severity < min ? s.severity : min, null);

    return { severity: worst ?? 10 }; // covered but no disruption → good service
  });
}

/** Build the complete board data structure. */
export function buildStatusBoard(
  snapshot: LedgerSnapshot,
  lineCatalog: LineCatalogEntry[],
  yourLineIds: string[],
  journeys: OverlapJourney[],
  now: Date,
): StatusBoard {
  const hasAnyLiveData = hasCoverage(snapshot.coverage, now);
  const nowMs = now.getTime();

  const rows: StatusLineRow[] = lineCatalog.map(line => {
    const active = worstActiveSpan(snapshot.spans, line.id, now);
    const hasLiveData = hasAnyLiveData;

    let severity: number;
    let description: string;
    let activeSpan: ActiveSpanSummary | null = null;
    let journeyOverlapCount = 0;

    if (active) {
      severity = active.severity;
      description = active.description;
      const startMs = new Date(active.from).getTime();
      activeSpan = {
        from: active.from,
        sinceLabel: formatSinceLabel(startMs, nowMs),
        elapsedShort: formatElapsedShort(startMs, nowMs),
        description: active.description,
        reason: active.reason,
      };
      journeyOverlapCount = countJourneyOverlaps(active, journeys, now);
    } else if (!hasLiveData) {
      severity = 10;
      description = 'No live data';
    } else {
      severity = 10;
      description = 'Good service';
    }

    const todayTimeline = buildTimeline(snapshot.spans, snapshot.coverage, line.id, now);

    return {
      lineId: line.id,
      lineName: line.name,
      lineColor: line.color,
      severity,
      description,
      hasLiveData,
      activeSpan,
      journeyOverlapCount,
      todayTimeline,
      isYourLine: yourLineIds.includes(line.id),
    };
  });

  // Within each section: disrupted (lower severity) rows first, then alpha
  const sortRows = (rs: StatusLineRow[]) =>
    [...rs].sort((a, b) => a.severity - b.severity || a.lineName.localeCompare(b.lineName));

  return {
    yourLines: sortRows(rows.filter(r => r.isYourLine)),
    otherLines: sortRows(rows.filter(r => !r.isYourLine)),
    generatedAt: snapshot.generatedAt,
    hasAnyLiveData,
  };
}
