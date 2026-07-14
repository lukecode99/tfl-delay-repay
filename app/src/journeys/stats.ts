// Transport-spend stats (TfL-24). Turns the combined raw-statements export —
// which, unlike the journeys table, keeps *every* mode (bus, tube, rail, river)
// — into the aggregates the Stats tab shows: total spend, spend per month, and
// the bus/tube/rail split. Pure and node-testable; zero React Native imports.
//
//   node --experimental-strip-types src/journeys/test-stats.ts
import { csvRows } from './parse.ts';
import { unescapeHtmlEntities } from './raw-export.ts';

export type TransportMode = 'tube' | 'bus' | 'rail' | 'river' | 'other';

export interface ModeSpend {
  mode: TransportMode;
  count: number;
  spend: number; // £, positive
}

export interface MonthSpend {
  month: string; // 'YYYY-MM'
  spend: number; // £, positive
  count: number;
}

export interface TransportStats {
  totalSpend: number; // £ across all modes
  journeyCount: number; // charged legs (£0 aborted touches excluded)
  earliestDate: string | null; // YYYY-MM-DD
  latestDate: string | null; // YYYY-MM-DD
  byMode: ModeSpend[]; // sorted by spend, descending
  byMonth: MonthSpend[]; // ascending by month
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify a Journey/Action string into a transport mode. Buses and river
 * buses are named explicitly by TfL; everything station-to-station is rail of
 * some kind, split into national "rail" only when the text says so (the
 * contactless export rarely distinguishes, so the vast majority land as
 * "tube" = Underground/Overground/Elizabeth/DLR).
 */
export function classifyMode(journey: string): TransportMode {
  const j = journey.toLowerCase();
  if (/bus journey|^bus\b|\broute \d+/.test(j)) return 'bus';
  if (/pier|river bus|thames clipper|uber boat|riverboat/.test(j)) return 'river';
  if (/ to /.test(j)) {
    if (/national rail|\(rail\)|railway|overground/.test(j)) return 'rail';
    return 'tube';
  }
  return 'other';
}

/** Parse a charge cell ("-1.75", "£3.40") to a positive £ number, or null. */
function parseCharge(s: string | undefined): number | null {
  const m = (s || '').replace(/[£\s]/g, '');
  if (!m) return null;
  const n = parseFloat(m);
  return Number.isNaN(n) ? null : Math.abs(n);
}

/** "01/06/2026" or "2026-06-01" → "2026-06-01" (null if unrecognised). */
function normDate(s: string): string | null {
  const t = (s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

interface Cols { date: number; time: number; journey: number; charge: number; }

function headerCols(row: string[]): Cols | null {
  const low = row.map(c => c.trim().toLowerCase());
  const find = (...names: string[]) => low.findIndex(h => names.some(n => h.includes(n)));
  const date = find('date');
  const journey = find('journey');
  if (date === -1 || journey === -1) return null;
  return { date, journey, time: find('time'), charge: find('charge', 'amount', 'fare') };
}

/**
 * Compute transport stats from a combined raw-statements blob (the output of
 * combineRawStatements) or any single TfL statement CSV. Tracks the current
 * card + column layout across `# ===== … card=… =====` banners and repeated
 * header rows, dedupes identical legs (card+date+time+journey), and excludes
 * £0 aborted touches so counts reflect real charged legs.
 */
export function computeStats(rawText: string): TransportStats {
  const rows = csvRows(unescapeHtmlEntities(rawText ?? ''));
  let card = '?';
  let cols: Cols | null = null;
  const seen = new Set<string>();
  const modeAgg = new Map<TransportMode, { count: number; spend: number }>();
  const monthAgg = new Map<string, { count: number; spend: number }>();
  let totalSpend = 0;
  let count = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const r of rows) {
    const first = (r[0] ?? '').trim();
    if (first.startsWith('#')) {
      const m = first.match(/card=([^\s]+)/);
      if (m) card = m[1];
      continue;
    }
    const asHeader = headerCols(r);
    if (asHeader) { cols = asHeader; continue; }
    if (!cols) continue;

    const date = normDate(r[cols.date] ?? '');
    const journey = (r[cols.journey] ?? '').trim();
    if (!date || !journey) continue;
    const charge = cols.charge >= 0 ? parseCharge(r[cols.charge]) : null;
    if (charge == null || charge === 0) continue; // skip aborted / uncharged touches

    const time = (cols.time >= 0 ? r[cols.time] : '')?.trim() ?? '';
    const key = `${card}|${date}|${time}|${journey}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const mode = classifyMode(journey);
    const month = date.slice(0, 7);
    const ma = modeAgg.get(mode) ?? { count: 0, spend: 0 };
    ma.count++; ma.spend += charge; modeAgg.set(mode, ma);
    const mo = monthAgg.get(month) ?? { count: 0, spend: 0 };
    mo.count++; mo.spend += charge; monthAgg.set(month, mo);
    totalSpend += charge;
    count++;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }

  const byMode = [...modeAgg.entries()]
    .map(([mode, v]) => ({ mode, count: v.count, spend: round2(v.spend) }))
    .sort((a, b) => b.spend - a.spend);
  const byMonth = [...monthAgg.entries()]
    .map(([month, v]) => ({ month, spend: round2(v.spend), count: v.count }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  return { totalSpend: round2(totalSpend), journeyCount: count, earliestDate: earliest, latestDate: latest, byMode, byMonth };
}

/** Display label + theme colour key for each mode (for the split legend). */
export const MODE_LABEL: Record<TransportMode, string> = {
  tube: 'Tube / Underground',
  bus: 'Bus',
  rail: 'National Rail',
  river: 'River bus',
  other: 'Other',
};
