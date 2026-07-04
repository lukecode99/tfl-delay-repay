// Expected journey timings from the TfL Journey Planner API, cached per
// station pair. Pure module — fetch and cache are injected so tests run
// without network and the app can back the cache with SQLite.

export interface RouteOption {
  durationMinutes: number;
  lines: string[]; // TfL line ids used by the route's rail legs
  modes: string[]; // e.g. ['tube'], ['elizabeth-line']
}

export interface PairTiming {
  expectedMinutes: number; // fastest route
  routes: RouteOption[]; // sorted fastest first
  plausibleLines: string[]; // union across routes — disruption match set
  fetchedAt: string; // ISO
}

export type FetchJson = (url: string) => Promise<any>;

export interface TimingCache {
  get(key: string): PairTiming | null | undefined;
  set(key: string, value: PairTiming): void;
}

export const pairKey = (fromId: string, toId: string) => `${fromId}|${toId}`;

const RAIL_MODES = new Set(['tube', 'dlr', 'overground', 'elizabeth-line']);

/** Parse a JourneyResults response into a PairTiming (exported for tests). */
export function parseJourneyResults(json: any, fetchedAt: string): PairTiming | null {
  const journeys = json?.journeys;
  if (!Array.isArray(journeys) || journeys.length === 0) return null;
  const routes: RouteOption[] = [];
  for (const j of journeys) {
    if (typeof j?.duration !== 'number') continue;
    const lines = new Set<string>();
    const modes = new Set<string>();
    for (const leg of j.legs ?? []) {
      const mode = leg?.mode?.id;
      if (!RAIL_MODES.has(mode)) continue; // skip walking/bus legs
      modes.add(mode);
      for (const ro of leg.routeOptions ?? []) {
        const id = ro?.lineIdentifier?.id;
        if (id) lines.add(id);
      }
    }
    routes.push({ durationMinutes: j.duration, lines: [...lines], modes: [...modes] });
  }
  if (!routes.length) return null;
  routes.sort((a, b) => a.durationMinutes - b.durationMinutes);
  return {
    expectedMinutes: routes[0].durationMinutes,
    routes,
    plausibleLines: [...new Set(routes.flatMap(r => r.lines))],
    fetchedAt,
  };
}

/**
 * Expected timing between two NaPTAN ids. Cache-first; a miss costs one
 * Journey Planner call. Returns null when the planner can't route the pair.
 */
export async function expectedTiming(
  fromId: string,
  toId: string,
  opts: { fetchJson: FetchJson; cache?: TimingCache; appKey?: string },
): Promise<PairTiming | null> {
  const key = pairKey(fromId, toId);
  const cached = opts.cache?.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({ mode: 'tube,dlr,overground,elizabeth-line' });
  if (opts.appKey) params.set('app_key', opts.appKey);
  const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${encodeURIComponent(fromId)}/to/${encodeURIComponent(toId)}?${params}`;
  const json = await opts.fetchJson(url);
  const timing = parseJourneyResults(json, new Date().toISOString());
  if (timing) opts.cache?.set(key, timing);
  return timing;
}
