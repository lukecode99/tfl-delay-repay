// HSP (Historic Service Performance) API client.
//
// The Rail Data Marketplace / HSP API requires HTTP Basic auth credentials
// registered at https://raildata.org.uk. Until credentials are provisioned,
// all lookups return null and the UI shows "delay not verified — enter
// manually". The credentials are injected by the caller (never hard-coded).
//
// Endpoint: POST https://hsp-prod.rockshore.net/api/v1/serviceMetrics
// Returns aggregate punctuality; individual service delay requires the RID
// from Darwin. For Phase 1 we use serviceMetrics to confirm average delay for
// the route on the travel date, which provides corroborating evidence even
// when no per-journey RID is available.

export interface HspCredentials {
  username: string;
  password: string;
}

export interface HspServiceMetric {
  /** Scheduled departure time HH:MM. */
  scheduledDepart: string;
  /** Actual arrival delay at the to_loc station (minutes). Null if cancelled. */
  delayMinutes: number | null;
  /** Whether the service was cancelled before reaching to_loc. */
  cancelled: boolean;
  /** Number of minutes late arriving at destination (raw from API). */
  lateArrivalMinutes: number | null;
}

export interface HspMetricsResult {
  fromCrs: string;
  toCrs: string;
  date: string; // YYYY-MM-DD
  services: HspServiceMetric[];
}

/** Fetch service metrics for a CRS pair on a specific date. */
export async function fetchHspMetrics(
  creds: HspCredentials | null,
  fromCrs: string,
  toCrs: string,
  date: string,
): Promise<HspMetricsResult | null> {
  if (!creds) return null;

  const token = btoa(`${creds.username}:${creds.password}`);
  let resp: Response;
  try {
    resp = await fetch('https://hsp-prod.rockshore.net/api/v1/serviceMetrics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${token}`,
      },
      body: JSON.stringify({
        from_loc: fromCrs.toUpperCase(),
        to_loc: toCrs.toUpperCase(),
        from_time: '0000',
        to_time: '2359',
        from_date: date,
        to_date: date,
        days: 'WEEKDAY',
      }),
    });
  } catch {
    return null; // network failure — treat as no data
  }

  if (!resp.ok) return null;
  let body: unknown;
  try { body = await resp.json(); } catch { return null; }

  const services = parseHspMetrics(body);
  return { fromCrs, toCrs, date, services };
}

function parseHspMetrics(body: unknown): HspServiceMetric[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const services = root['Services'];
  if (!Array.isArray(services)) return [];
  const out: HspServiceMetric[] = [];
  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;
    const s = svc as Record<string, unknown>;
    const attrs = s['serviceAttributesMetrics'];
    if (!attrs || typeof attrs !== 'object') continue;
    const a = attrs as Record<string, unknown>;
    const schedDepart = String(a['origin_gbtt_ptd'] ?? '');
    if (!schedDepart || schedDepart.length < 4) continue;
    const hh = schedDepart.slice(0, 2);
    const mm = schedDepart.slice(2, 4);
    const scheduledDepart = `${hh}:${mm}`;

    const lateArr = a['late_arrival_time'];
    const cancelled = Boolean(a['cancelled_en_route'] || a['cancel_reason_code']);
    const lateArrivalMinutes = typeof lateArr === 'number' ? lateArr : null;

    out.push({
      scheduledDepart,
      delayMinutes: cancelled ? null : lateArrivalMinutes,
      cancelled,
      lateArrivalMinutes,
    });
  }
  return out;
}

/**
 * Find the closest service to a requested departure time and return its
 * delay. Returns null when no service is within 30 minutes.
 */
export function matchService(
  result: HspMetricsResult,
  scheduledDepart: string, // HH:MM
): HspServiceMetric | null {
  const [rh, rm] = scheduledDepart.split(':').map(Number);
  const reqMins = rh * 60 + rm;
  let best: HspServiceMetric | null = null;
  let bestDiff = Infinity;
  for (const svc of result.services) {
    const [sh, sm] = svc.scheduledDepart.split(':').map(Number);
    const diff = Math.abs(sh * 60 + sm - reqMins);
    if (diff < bestDiff && diff <= 30) {
      bestDiff = diff;
      best = svc;
    }
  }
  return best;
}
