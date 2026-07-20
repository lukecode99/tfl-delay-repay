// Clusters stored journeys by (day-of-week, hour-bucket) to find the top-6
// recurring commute windows. Used by recommended-mode subscriptions — 100%
// on-device, no server, purely from the user's own history.
import type { StoredJourney } from '../journeys/db';
import { inferLines } from './line-inference';

export interface JourneyCluster {
  /** ISO day of week: 1 = Monday … 7 = Sunday */
  dayOfWeek: number;
  /** Start of the notification window: avg tap-in minus 1 hour (HH:MM) */
  windowStart: string;
  /** End of the notification window: avg tap-out plus 1 hour (HH:MM) */
  windowEnd: string;
  /** Most common origin in this cluster */
  origin: string;
  /** Most common destination (null if ambiguous or all null) */
  destination: string | null;
  /** Inferred lines (empty = unknown — user must pick manually) */
  lines: string[];
  /** Number of journeys that formed this cluster */
  count: number;
  /** Average tap-in time (HH:MM) — for display */
  avgTapIn: string;
  /** Average tap-out time (HH:MM) — for display */
  avgTapOut: string | null;
}

interface Bucket {
  dayOfWeek: number;
  hourBucket: number; // 0–23
  journeys: StoredJourney[];
}

function parseTime(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(minutes: number): string {
  const clamped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const m = Math.floor(clamped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dayOfWeek(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=Mon…7=Sun
}

function mode<T>(arr: T[]): T {
  const counts = new Map<string, number>();
  let best = arr[0], bestCount = 0;
  for (const v of arr) {
    const k = String(v);
    const c = (counts.get(k) ?? 0) + 1;
    counts.set(k, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}

export function clusterJourneys(journeys: StoredJourney[]): JourneyCluster[] {
  // Only cluster journeys with a tap-in time
  const valid = journeys.filter(j => j.tapInTime);

  // Group by (dayOfWeek, hourBucket)
  const map = new Map<string, Bucket>();
  for (const j of valid) {
    const dow = dayOfWeek(j.date);
    const tapInMin = parseTime(j.tapInTime);
    if (tapInMin === null) continue;
    const hourBucket = Math.floor(tapInMin / 60);
    const key = `${dow}-${hourBucket}`;
    if (!map.has(key)) map.set(key, { dayOfWeek: dow, hourBucket, journeys: [] });
    map.get(key)!.journeys.push(j);
  }

  // Sort by frequency desc, take top 6
  const buckets = Array.from(map.values()).sort((a, b) => b.journeys.length - a.journeys.length);
  const top = buckets.slice(0, 6);

  return top.map(bucket => {
    const jjs = bucket.journeys;

    const tapInMins = jjs.map(j => parseTime(j.tapInTime)).filter((x): x is number => x !== null);
    const tapOutMins = jjs.map(j => parseTime(j.tapOutTime)).filter((x): x is number => x !== null);

    const avgTapIn = tapInMins.reduce((a, b) => a + b, 0) / tapInMins.length;
    const avgTapOut = tapOutMins.length > 0
      ? tapOutMins.reduce((a, b) => a + b, 0) / tapOutMins.length
      : null;

    const windowStart = minutesToHHMM(avgTapIn - 60);
    const windowEnd = minutesToHHMM((avgTapOut ?? avgTapIn + 60) + 60);

    const origin = mode(jjs.map(j => j.origin));
    const destinations = jjs.map(j => j.destination).filter((x): x is string => x !== null);
    const destination = destinations.length > 0 ? mode(destinations) : null;

    const lines = inferLines(origin, destination);

    return {
      dayOfWeek: bucket.dayOfWeek,
      windowStart,
      windowEnd,
      origin,
      destination,
      lines,
      count: jjs.length,
      avgTapIn: minutesToHHMM(avgTapIn),
      avgTapOut: avgTapOut !== null ? minutesToHHMM(avgTapOut) : null,
    };
  });
}
