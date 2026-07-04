// Station-name resolution core. Pure and data-injected (no JSON imports) so
// it runs under plain node for tests; resolve.ts binds it to the bundled
// dataset for the app.
import type { Station } from '../data';

/** Normalise a station name for matching: strip qualifiers, punctuation, suffixes. */
export function normalizeStationName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[.*?\]/g, ' ') // "[London Underground]", "[Dlr]"
    .replace(/\(.*?\)/g, ' ') // "(Bakerloo)" platform qualifiers
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(london )?(underground|rail|dlr|overground) station\b/g, ' ')
    .replace(/\bstation\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a resolver over a station list. Exact normalised match wins; then
 * prefix either way ("kings cross" ↔ "kings cross st pancras"); then
 * substring. Stations that exist twice under the same name (e.g. Heathrow T4
 * tube + rail) tie-break to the one serving more lines, keeping the
 * plausible-line set broad.
 */
export function makeResolver(stations: Station[]): (raw: string) => Station | null {
  const normalized = stations.map(s => ({ norm: normalizeStationName(s.name), station: s }));
  return (raw: string) => {
    const q = normalizeStationName(raw);
    if (!q) return null;
    let best: { station: Station; score: number } | null = null;
    for (const { norm, station } of normalized) {
      let score = 0;
      if (norm === q) score = 100;
      else if (norm.startsWith(q) || q.startsWith(norm)) score = 60;
      else if (norm.includes(q) || q.includes(norm)) score = 30;
      if (score === 0) continue;
      // Prefer tighter name-length matches, then better-connected stations.
      score -= Math.abs(norm.length - q.length) * 0.1;
      score += station.lines.length * 0.01;
      if (!best || score > best.score) best = { station, score };
    }
    return best?.station ?? null;
  };
}
