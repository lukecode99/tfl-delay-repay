// Typed access to the bundled station/fare dataset (regenerate with build-dataset.mjs).
import stationsJson from './stations.json';
import faresJson from './fares.json';

export interface Station {
  id: string; // Naptan id, e.g. 940GZZLUVIC
  name: string; // display name, e.g. "Victoria"
  fullName: string;
  zone: string | null; // "2", "2+3" (boundary) or null (out of zones, e.g. Reading)
  lat: number;
  lon: number;
  lines: string[]; // line ids
}

export interface LineInfo {
  id: string;
  name: string;
  mode: string;
}

export interface Fare {
  peak: number | null;
  offPeak: number | null;
}

export const stations: Station[] = stationsJson.stations as Station[];
export const lines: LineInfo[] = stationsJson.lines as LineInfo[];
const fareMatrix: Record<string, Fare> = faresJson.matrix as Record<string, Fare>;

const byId = new Map(stations.map(s => [s.id, s]));
export const stationById = (id: string): Station | undefined => byId.get(id);

/** Zones a station can count as — boundary stations ("2+3" or "2/3") belong to both. */
function zonesOf(station: Station): number[] {
  if (!station.zone) return [];
  return station.zone.split(/[+/]/).map(Number).filter(n => !Number.isNaN(n));
}

/**
 * Estimated Adult PAYG single fare between two stations from the bundled
 * zone-range matrix. Boundary stations use whichever of their zones gives the
 * cheapest fare (matching how TfL charges). Returns null when either station
 * is outside the zone system (e.g. Reading) — the CSV statement's actual
 * charge should be used instead wherever it's available.
 */
export function estimateFare(fromId: string, toId: string): Fare | null {
  const from = byId.get(fromId);
  const to = byId.get(toId);
  if (!from || !to) return null;
  const fz = zonesOf(from);
  const tz = zonesOf(to);
  if (!fz.length || !tz.length) return null;
  let best: Fare | null = null;
  for (const a of fz) {
    for (const b of tz) {
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      const fare = fareMatrix[key];
      if (!fare || fare.peak == null) continue;
      if (!best || (fare.peak ?? Infinity) < (best.peak ?? Infinity)) best = fare;
    }
  }
  return best;
}

/** Case/punctuation-insensitive prefix+substring search over station names. */
export function searchStations(query: string, limit = 8): Station[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: Station[] = [];
  const contains: Station[] = [];
  for (const s of stations) {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) starts.push(s);
    else if (n.includes(q)) contains.push(s);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
