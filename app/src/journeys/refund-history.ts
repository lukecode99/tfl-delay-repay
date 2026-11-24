// Parser + matcher for TfL's Delay Repay refund-history page (TfL-36).
//
// The journey-history CSV the app imports carries NO refund rows, and the
// money itself lands card-side (invisible to us). The ONLY TfL source for an
// in-flight refund is a separate screen:
//   https://contactless.tfl.gov.uk/Refunds/RefundHistory?cardDisplayId=<id>
//
// Real markup (captured from a live account via the refund-raw audit, TfL-37):
// each application is a div.journey-tile carrying data-pageobject attributes —
//   <h3 data-pageobject="refund-travelday">Wednesday 28th October 2026</h3>
//   <span data-pageobject="journey-from">White City</span> <span>to</span>
//   <span data-pageobject="journey-to">Northolt</span>
//   <h4 data-pageobject="refund-status">Service delay refund application submitted</h4>
// The route being split across three sibling spans is why a text-strip parser
// cannot see "X to Y" on one line: parse the MARKUP first, keyed on those
// data-pageobject hooks (they are TfL's own test ids, so more stable than
// layout), and keep the old line state machine only as a fallback.
//
// Pure module — no React Native imports — so it runs under plain node for
// tests (node --experimental-strip-types src/journeys/test-refund-history.ts).

export type RefundAppStatus = 'submitted' | 'approved' | 'paid' | 'rejected' | 'unknown';

export interface RefundApplication {
  date: string; // YYYY-MM-DD — the delayed JOURNEY's date (what the screen shows)
  origin: string;
  destination: string;
  status: RefundAppStatus;
  rawStatus: string; // the status line verbatim, for display/debugging
  card?: string | null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const DOW = /^(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)\b/i;
const REFUND_LINE = /\brefund\b|\bdelay repay\b|application (submitted|approved|received|paid|refunded|rejected|declined|unsuccessful)/i;
const NOTIFY_LINE = /you will be notified|notified of the outcome|separately via email/i;

/** Classify a status line into our enum. Order matters: a "rejected" line can
 * also contain the word "refund", so negatives/positives are tested before the
 * generic "submitted" fallback. */
export function classifyStatus(line: string): RefundAppStatus {
  const s = line.toLowerCase();
  // Negations first: "unable to approve" / "not approved" are rejections even
  // though they contain the word "approve".
  if (/reject|declin|unsuccess|(unable to|cannot|could ?n.?t|can ?not|not able to) (approve|refund)|not (be )?(approved|successful|upheld)/.test(s)) return 'rejected';
  if (/\bpaid\b|refunded to|has been refunded|payment (made|issued)/.test(s)) return 'paid';
  if (/approv|accepted|successful|upheld/.test(s)) return 'approved';
  if (/submitted|received|under review|being (reviewed|processed)|pending/.test(s)) return 'submitted';
  return 'unknown';
}

/**
 * "Wednesday 28th October 2026" / "Wed 21 Oct" / "21 October" → YYYY-MM-DD.
 * Ordinal suffixes are stripped; a missing year is inferred relative to nowISO:
 * the most recent occurrence of that day+month that isn't in the future (a
 * refund application is always for a past journey). Returns null if the text
 * carries no recognisable day+month.
 */
export function parseRefundDate(text: string, nowISO: string): string | null {
  const t = String(text || '')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1') // 28th → 28
    .trim();
  // Already a full ISO date somewhere?
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Explicit year "21 Oct 2026" / "21 October 2026".
  const withYear = t.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (withYear) {
    const mon = MONTHS[withYear[2].slice(0, 3).toLowerCase()];
    if (mon) return `${withYear[3]}-${mon}-${withYear[1].padStart(2, '0')}`;
  }
  // Year-less "Wed 21 Oct" / "21 October".
  const m = t.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = m[1].padStart(2, '0');
  const nowY = Number(nowISO.slice(0, 4));
  const nowMD = nowISO.slice(5, 10); // MM-DD
  const md = `${mon}-${day}`;
  // If MM-DD is after today, it must belong to last year.
  const year = md > nowMD ? nowY - 1 : nowY;
  return `${year}-${md}`;
}

/** Strip HTML to a list of trimmed, non-empty text lines. Scripts/styles are
 * dropped; every tag becomes a line break; entities are decoded. */
export function htmlToLines(html: string): string[] {
  const text = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
  return text
    .split(/\n+/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A line that is a station-to-station route and not a status/notice line. */
function routeOf(line: string): { origin: string; destination: string } | null {
  if (REFUND_LINE.test(line) || NOTIFY_LINE.test(line)) return null;
  const m = line.match(/^(.+?) to (.+)$/i);
  if (!m) return null;
  const origin = m[1].trim();
  const destination = m[2].trim();
  if (!origin || !destination) return null;
  // Guard against prose "...notified of the outcome..." slipping through.
  if (/\b(outcome|email|notified|application)\b/i.test(destination)) return null;
  return { origin, destination };
}

const decodeEntities = (s: string): string => s
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'");

/** Text content of the first element in `chunk` tagged with the given
 * data-pageobject value, or null. Only direct text (up to the next tag) is
 * taken — every field on this page is a leaf element. */
function pageObjectText(chunk: string, name: string): string | null {
  const m = chunk.match(new RegExp(`data-pageobject=["']${name}["'][^>]*>([^<]*)<`, 'i'));
  if (!m) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Markup-first parse: one application per journey-tile, fields keyed on TfL's
 * own data-pageobject attributes. A tile missing any of date/from/to/status is
 * skipped entirely — no data beats dodgy data. */
function parseRefundTiles(html: string, nowISO: string, card?: string | null): RefundApplication[] {
  const src = String(html || '');
  if (!/data-pageobject=["']refund-travelday["']/i.test(src)) return [];
  // Split on tile boundaries; every chunk after the first holds one tile's
  // inner markup (up to the start of the next tile).
  const chunks = src.split(/class=["'][^"']*journey-tile[^"']*["']/i).slice(1);
  const out: RefundApplication[] = [];
  for (const chunk of chunks) {
    const dateText = pageObjectText(chunk, 'refund-travelday');
    const origin = pageObjectText(chunk, 'journey-from');
    const destination = pageObjectText(chunk, 'journey-to');
    const rawStatus = pageObjectText(chunk, 'refund-status');
    if (!dateText || !origin || !destination || !rawStatus) continue;
    const date = parseRefundDate(dateText, nowISO);
    if (!date) continue;
    out.push({ date, origin, destination, status: classifyStatus(rawStatus), rawStatus, card: card ?? null });
  }
  return out;
}

/**
 * Parse one refund-history page's HTML into applications. The real page is
 * handled by parseRefundTiles (data-pageobject markup); the line state machine
 * below is the fallback for any markup shape without those hooks: a date line
 * arms pendingDate, a route line arms pendingRoute, and a refund/status line
 * flushes the trio into an application.
 */
export function parseRefundHistory(html: string, nowISO: string, card?: string | null): RefundApplication[] {
  const fromTiles = parseRefundTiles(html, nowISO, card);
  if (fromTiles.length > 0) return dedupeApps(fromTiles);
  const lines = htmlToLines(html);
  const out: RefundApplication[] = [];
  let pendingDate: string | null = null;
  let pendingRoute: { origin: string; destination: string } | null = null;

  for (const line of lines) {
    // Status line flushes a complete entry.
    if (REFUND_LINE.test(line) && !NOTIFY_LINE.test(line)) {
      const status = classifyStatus(line);
      if (pendingDate && pendingRoute) {
        out.push({
          date: pendingDate,
          origin: pendingRoute.origin,
          destination: pendingRoute.destination,
          status,
          rawStatus: line,
          card: card ?? null,
        });
        pendingRoute = null; // keep date in case the next route shares it (rare)
      }
      continue;
    }
    if (NOTIFY_LINE.test(line)) continue;

    const route = routeOf(line);
    if (route) { pendingRoute = route; continue; }

    // Date line (year-less "Wed 21 Oct" or a month-group header "October").
    const d = DOW.test(line) || /^\d{1,2}\s+[A-Za-z]{3,}/.test(line)
      ? parseRefundDate(line, nowISO)
      : null;
    if (d) pendingDate = d;
  }
  return dedupeApps(out);
}

/** Dedupe identical rows (page can repeat an entry across responsive layouts). */
function dedupeApps(apps: RefundApplication[]): RefundApplication[] {
  const seen = new Set<string>();
  return apps.filter(a => {
    const k = `${a.date}|${a.origin.toLowerCase()}|${a.destination.toLowerCase()}|${a.status}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- Matching refund applications back to stored journeys ---

export interface RefundAppMatchJourney {
  id: number;
  date: string; // YYYY-MM-DD
  origin: string;
  destination?: string | null;
  card?: string | null;
}

/** Strength order so a conflicting match keeps the most advanced state. */
const RANK: Record<RefundAppStatus, number> = {
  paid: 4, approved: 3, submitted: 2, rejected: 1, unknown: 0,
};

function norm(s: string | null | undefined): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameCard(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === 'unknown' || b === 'unknown') return true;
  return a.toLowerCase() === b.toLowerCase();
}

function dayDiff(aISO: string, bISO: string): number {
  const a = new Date(aISO.slice(0, 10)).getTime();
  const b = new Date(bISO.slice(0, 10)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.abs(Math.round((a - b) / 86400000));
}

/**
 * Match refund applications to journeys by date + route (they carry no amount,
 * so the amount-based matcher in refund-match.ts can't bind them). The screen
 * shows the delayed journey's own date and route, so the match is tight: same
 * day (±1 for timezone slack), same origin AND destination (normalised), same
 * card when both are known. Requires EXACTLY ONE candidate per application —
 * "no data beats dodgy data". Returns journeyId → the matched status (strongest
 * wins on the rare conflict).
 */
export function matchRefundApplicationsToJourneys(
  apps: RefundApplication[],
  journeys: RefundAppMatchJourney[],
): Map<number, RefundAppStatus> {
  const result = new Map<number, RefundAppStatus>();
  if (!apps.length || !journeys.length) return result;

  for (const app of apps) {
    const ao = norm(app.origin);
    const ad = norm(app.destination);
    const candidates = journeys.filter(j => {
      if (!j.destination) return false;
      const d = dayDiff(app.date, j.date);
      if (Number.isNaN(d) || d > 1) return false;
      if (!sameCard(app.card, j.card)) return false;
      return norm(j.origin) === ao && norm(j.destination) === ad;
    });
    if (candidates.length !== 1) continue;
    const id = candidates[0].id;
    const prev = result.get(id);
    if (prev === undefined || RANK[app.status] > RANK[prev]) result.set(id, app.status);
  }
  return result;
}

/** Statuses that mean the refund is in hand / coming (feeds the Received
 * filter). A rejected or unknown application is tracked and badged but is NOT
 * treated as received. */
export function isReceivedStatus(s: RefundAppStatus): boolean {
  return s === 'submitted' || s === 'approved' || s === 'paid';
}
