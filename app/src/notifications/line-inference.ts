// Infers which TfL lines serve an origin→destination pair using the bundled
// station→lines map built from the TfL API. Both station names come from TfL
// CSV exports, which include suffixes like " Underground Station" — we strip
// those before the lookup to maximise hit rate.
import tubeGraph from './tube-graph.json';

const GRAPH = tubeGraph as Record<string, string[]>;

const STRIP_SUFFIXES = [
  ' Underground Station',
  ' DLR Station',
  ' Elizabeth Line Station',
  ' Overground Station',
  ' Rail Station',
  ' Station',
];

function normalize(name: string): string {
  let n = name.trim();
  for (const s of STRIP_SUFFIXES) {
    if (n.endsWith(s)) {
      n = n.slice(0, -s.length);
      break;
    }
  }
  // Normalize apostrophes and collapse whitespace
  return n.replace(/[''`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

// Pre-build a lowercase-keyed map once at module load
const GRAPH_LOWER: Record<string, string[]> = {};
for (const [k, v] of Object.entries(GRAPH)) {
  GRAPH_LOWER[normalize(k)] = v;
}

function linesFor(station: string): string[] {
  return GRAPH_LOWER[normalize(station)] ?? [];
}

/**
 * Returns lines that serve both origin and destination (i.e. a direct-service
 * candidate). Falls back to union of origin lines if no overlap (interchange
 * journey). Returns [] if neither station is recognised.
 */
export function inferLines(origin: string, destination: string | null): string[] {
  const oLines = linesFor(origin);
  if (!destination) return oLines;
  const dLines = linesFor(destination);

  // Direct service: lines that serve both stations
  const shared = oLines.filter(l => dLines.includes(l));
  if (shared.length > 0) return shared;

  // Interchange: no single line covers both — return origin lines as a hint
  if (oLines.length > 0) return oLines;
  return dLines;
}

/** True if the station exists in the bundled graph. */
export function stationKnown(name: string): boolean {
  return normalize(name) in GRAPH_LOWER;
}
