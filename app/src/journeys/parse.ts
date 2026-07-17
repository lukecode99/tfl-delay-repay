// Parser for TfL journey-history CSV statements (Oyster and contactless
// exports). Pure module — no React Native imports — so it runs under plain
// node for tests (node --experimental-strip-types).

export interface ParsedJourney {
  card: string; // card identifier; falls back to the caller's default
  date: string; // YYYY-MM-DD
  tapInTime: string | null; // HH:MM
  tapOutTime: string | null; // HH:MM
  origin: string;
  destination: string | null; // null when tap-out is missing
  charge: number | null; // £; null when the row carries no charge
  incomplete: boolean; // missing tap-out — flagged, never dropped
  rawAction: string; // original Journey/Action text, for display/debugging
}

export interface ParsedRefund {
  date: string; // YYYY-MM-DD
  credit: number; // positive £ amount
  rawAction: string;
}

export interface ParseResult {
  journeys: ParsedJourney[];
  refunds: ParsedRefund[]; // Delay Repay credit rows
  skipped: number; // non-journey rows (top-ups, bus journeys…)
  malformed: number; // rows that looked like journeys but didn't parse
}

/** Minimal CSV reader with quoted-field support. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "31-May-2026", "31/05/2026" or "2026-05-31" → "2026-05-31" (null if unrecognised). */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? `${m[3]}-${mon}-${m[1].padStart(2, '0')}` : null;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // UK day-first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function parseTime(s: string | undefined): string | null {
  const m = (s || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function parseCharge(s: string | undefined): number | null {
  const m = (s || '').replace(/[£\s]/g, '');
  if (!m) return null;
  const n = parseFloat(m);
  // Contactless web exports list journey charges as negative amounts
  // (-3.40); fares are stored as positive £ regardless of export sign.
  return Number.isNaN(n) ? null : Math.abs(n);
}

const NO_TOUCH = /no touch[- ](in|out)/i;

/**
 * Parse a TfL statement CSV. Handles the Oyster export
 * (Date,Start Time,End Time,Journey/Action,Charge,Credit,Balance,Note) and
 * contactless variants; column order is taken from the header row. Rows that
 * aren't station-to-station journeys (top-ups, bus journeys, refunds) are
 * counted in `skipped`. Journeys without a tap-out are kept with
 * `incomplete: true`.
 */
export function parseStatement(text: string, defaultCard = 'unknown'): ParseResult {
  const rows = csvRows(text);
  const result: ParseResult = { journeys: [], refunds: [], skipped: 0, malformed: 0 };
  const headerIdx = rows.findIndex(r => {
    const lower = r.map(c => c.toLowerCase());
    return lower.some(c => c.includes('date')) && lower.some(c => c.includes('journey'));
  });
  if (headerIdx === -1) return result;
  const header = rows[headerIdx].map(c => c.trim().toLowerCase());
  const col = (...names: string[]) =>
    header.findIndex(h => names.some(n => h.includes(n)));
  const ci = {
    date: col('date'),
    start: col('start time', 'touch in', 'start'),
    end: col('end time', 'touch out', 'end'),
    time: col('time'), // combined "08:55 - 09:22" column (contactless web export)
    action: col('journey'),
    charge: col('charge', 'amount', 'fare'),
    credit: col('credit'),
    note: col('note'),
    card: col('card'),
  };

  for (const r of rows.slice(headerIdx + 1)) {
    const action = (r[ci.action] || '').trim();
    if (!action) { result.skipped++; continue; }
    const date = ci.date >= 0 ? parseDate(r[ci.date] || '') : null;

    // Delay Repay credit rows: TfL credits refunds as "Delay Repay" or
    // "Service delay refund" actions with a Credit column amount.
    if (/delay.?repay|service.?delay.?refund/i.test(action)) {
      if (date) {
        const credit = parseCharge(ci.credit >= 0 ? r[ci.credit] : undefined)
                    ?? parseCharge(ci.charge >= 0 ? r[ci.charge] : undefined);
        if (credit && credit > 0) result.refunds.push({ date, credit, rawAction: action });
        else result.skipped++;
      } else result.skipped++;
      continue;
    }

    // Only "X to Y" rows are rail journeys; everything else (Auto top-up,
    // "Bus journey, route 73", season tickets) is out of scope.
    const m = action.match(/^(.+?) to (.+)$/i);
    if (!m || /^bus journey/i.test(action)) { result.skipped++; continue; }
    if (!date) { result.malformed++; continue; }

    const origin = m[1].trim();
    let destination: string | null = m[2].trim();
    let tapInTime = parseTime(ci.start >= 0 ? r[ci.start] : undefined);
    let tapOutTime = parseTime(ci.end >= 0 ? r[ci.end] : undefined);
    if (ci.start === -1 && ci.end === -1 && ci.time >= 0) {
      // Contactless web export: one "Time" column, "08:55 - 09:22"
      // (single "17:24" for bus rows, which never reach here).
      const parts = (r[ci.time] || '').split(/[-–]/);
      tapInTime = parseTime(parts[0]);
      tapOutTime = parts.length > 1 ? parseTime(parts[1]) : null;
    }
    const note = ci.note >= 0 ? (r[ci.note] || '') : '';

    let incomplete = false;
    if (NO_TOUCH.test(destination) || NO_TOUCH.test(note) || !tapOutTime) {
      incomplete = true;
      if (NO_TOUCH.test(destination)) destination = null;
      tapOutTime = NO_TOUCH.test(note) ? null : tapOutTime;
    }
    if (NO_TOUCH.test(origin)) { result.malformed++; continue; } // unusable without origin

    result.journeys.push({
      card: (ci.card >= 0 && r[ci.card]?.trim()) || defaultCard,
      date,
      tapInTime,
      tapOutTime,
      origin,
      destination,
      charge: parseCharge(ci.charge >= 0 ? r[ci.charge] : undefined),
      incomplete,
      rawAction: action,
    });
  }
  return result;
}

/** Dedupe key per card spec: card + tap-in datetime + origin. */
export function journeyKey(j: ParsedJourney): string {
  return `${j.card}|${j.date}T${j.tapInTime ?? '??'}|${j.origin}`;
}
