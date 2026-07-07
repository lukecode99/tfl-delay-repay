// Rail journey store — pure SQL over DbLike, mirroring journeys/store-core.ts
// so the DB logic is testable under plain node (node:sqlite adapter).
import type { DbLike } from '../journeys/store-core.ts';

export type RailOperator = 'avanti' | 'southern' | 'gtr';
export type TicketType = 'single' | 'return';
export type ClaimStatus = 'pending' | 'filed' | 'paid' | 'rejected';

export interface RailJourney {
  id: number;
  originCrs: string;
  destinationCrs: string;
  departureDate: string;          // YYYY-MM-DD
  scheduledDepart: string;        // HH:MM
  actualDepart: string | null;
  scheduledArrive: string | null;
  actualArrive: string | null;
  delayMinutes: number | null;
  operator: RailOperator;
  ticketPricePence: number | null; // stored as integer pence (e.g. £45.50 → 4550)
  ticketType: TicketType | null;
  ticketRef: string | null;        // optional e-ticket reference
  claimDeadline: string | null;    // DATE, departure_date + 28 days
  claimedAt: string | null;        // ISO timestamp
  claimStatus: ClaimStatus;
  importedAt: string;              // ISO timestamp
}

/** Create rail_journeys table on a fresh install. Idempotent. */
export function ensureRailSchema(d: DbLike): void {
  d.execSync(`
    CREATE TABLE IF NOT EXISTS rail_journeys (
      id INTEGER PRIMARY KEY,
      origin_crs TEXT NOT NULL,
      destination_crs TEXT NOT NULL,
      departure_date TEXT NOT NULL,
      scheduled_depart TEXT NOT NULL,
      actual_depart TEXT,
      scheduled_arrive TEXT,
      actual_arrive TEXT,
      delay_minutes INTEGER,
      operator TEXT NOT NULL,
      ticket_price_pence INTEGER,
      ticket_type TEXT,
      ticket_ref TEXT,
      claim_deadline TEXT,
      claimed_at TEXT,
      claim_status TEXT NOT NULL DEFAULT 'pending',
      imported_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_journeys_dedupe
      ON rail_journeys (origin_crs, destination_crs, departure_date, scheduled_depart, operator);
    CREATE INDEX IF NOT EXISTS idx_rail_journeys_date ON rail_journeys (departure_date);
  `);
}

/**
 * Migrate an existing rail_journeys table created before the NR-1 QA fix.
 * Safe to call on a fresh table (all ALTER TABLE ops are no-ops if the column
 * exists, handled by the try/catch wrapper).
 *
 * Migration steps:
 *  1. Add new columns (ticket_type, ticket_ref, claim_deadline,
 *     ticket_price_pence, claim_status) if absent.
 *  2. Populate ticket_price_pence from old single_fare REAL column.
 *  3. Set claim_deadline = departure_date + 28 days (fallback: imported_at).
 *  4. Set claim_status from claimed_at.
 */
export function migrateRailSchema(d: DbLike): void {
  const columns = d.getAllSync<{ name: string }>(
    "SELECT name FROM pragma_table_info('rail_journeys')",
  ).map(r => r.name);

  const add = (col: string, def: string) => {
    if (!columns.includes(col)) {
      d.execSync(`ALTER TABLE rail_journeys ADD COLUMN ${col} ${def}`);
    }
  };

  add('ticket_price_pence', 'INTEGER');
  add('ticket_type', 'TEXT');
  add('ticket_ref', 'TEXT');
  add('claim_deadline', 'TEXT');
  add('claim_status', "TEXT NOT NULL DEFAULT 'pending'");

  // Migrate single_fare (pounds, REAL) → ticket_price_pence (pence, INTEGER)
  if (columns.includes('single_fare')) {
    d.execSync(
      `UPDATE rail_journeys
       SET ticket_price_pence = CAST(ROUND(single_fare * 100) AS INTEGER)
       WHERE single_fare IS NOT NULL AND ticket_price_pence IS NULL`,
    );
  }

  // claim_deadline = departure_date + 28 days; fallback to imported_at + 28
  d.execSync(
    `UPDATE rail_journeys
     SET claim_deadline = date(
       COALESCE(departure_date, substr(imported_at, 1, 10)),
       '+28 days'
     )
     WHERE claim_deadline IS NULL`,
  );

  // claim_status from claimed_at
  d.execSync(
    `UPDATE rail_journeys
     SET claim_status = CASE WHEN claimed_at IS NOT NULL THEN 'filed' ELSE 'pending' END
     WHERE claim_status = 'pending' OR claim_status IS NULL`,
  );
}

/** Compute claim_deadline string (departure_date + 28 days) in JS. */
function claimDeadlineFor(departureDate: string): string {
  const [y, m, da] = departureDate.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, da + 28));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function rowToJourney(r: Record<string, unknown>): RailJourney {
  return {
    id: r.id as number,
    originCrs: r.origin_crs as string,
    destinationCrs: r.destination_crs as string,
    departureDate: r.departure_date as string,
    scheduledDepart: r.scheduled_depart as string,
    actualDepart: (r.actual_depart as string | null) ?? null,
    scheduledArrive: (r.scheduled_arrive as string | null) ?? null,
    actualArrive: (r.actual_arrive as string | null) ?? null,
    delayMinutes: (r.delay_minutes as number | null) ?? null,
    operator: r.operator as RailOperator,
    ticketPricePence: (r.ticket_price_pence as number | null) ?? null,
    ticketType: (r.ticket_type as TicketType | null) ?? null,
    ticketRef: (r.ticket_ref as string | null) ?? null,
    claimDeadline: (r.claim_deadline as string | null) ?? null,
    claimedAt: (r.claimed_at as string | null) ?? null,
    claimStatus: ((r.claim_status as string | null) ?? 'pending') as ClaimStatus,
    importedAt: r.imported_at as string,
  };
}

export function insertRailJourney(
  d: DbLike,
  j: Omit<RailJourney, 'id'>,
  now: string,
): number | null {
  const deadline = j.claimDeadline ?? claimDeadlineFor(j.departureDate);
  const res = d.runSync(
    `INSERT OR IGNORE INTO rail_journeys
       (origin_crs, destination_crs, departure_date, scheduled_depart,
        actual_depart, scheduled_arrive, actual_arrive, delay_minutes,
        operator, ticket_price_pence, ticket_type, ticket_ref,
        claim_deadline, claimed_at, claim_status, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    j.originCrs, j.destinationCrs, j.departureDate, j.scheduledDepart,
    j.actualDepart, j.scheduledArrive, j.actualArrive, j.delayMinutes,
    j.operator, j.ticketPricePence, j.ticketType, j.ticketRef,
    deadline, j.claimedAt, j.claimStatus ?? 'pending', now,
  );
  if (res.changes === 0) return null;
  const row = d.getFirstSync<{ id: number }>('SELECT last_insert_rowid() AS id');
  return row?.id ?? null;
}

export function updateRailActuals(
  d: DbLike,
  id: number,
  actualDepart: string | null,
  actualArrive: string | null,
  delayMinutes: number | null,
): void {
  d.runSync(
    `UPDATE rail_journeys
     SET actual_depart = ?, actual_arrive = ?, delay_minutes = ?
     WHERE id = ?`,
    actualDepart, actualArrive, delayMinutes, id,
  );
}

export function listRailJourneys(d: DbLike, limit = 100): RailJourney[] {
  return d.getAllSync<Record<string, unknown>>(
    'SELECT * FROM rail_journeys ORDER BY departure_date DESC, scheduled_depart DESC LIMIT ?',
    limit,
  ).map(rowToJourney);
}

export function getRailJourney(d: DbLike, id: number): RailJourney | null {
  const row = d.getFirstSync<Record<string, unknown>>(
    'SELECT * FROM rail_journeys WHERE id = ?', id,
  );
  return row ? rowToJourney(row) : null;
}

export function markRailClaimed(d: DbLike, id: number, at: string): void {
  d.runSync(
    `UPDATE rail_journeys SET claimed_at = ?, claim_status = 'filed' WHERE id = ?`,
    at, id,
  );
}

export function unmarkRailClaimed(d: DbLike, id: number): void {
  d.runSync(
    `UPDATE rail_journeys SET claimed_at = NULL, claim_status = 'pending' WHERE id = ?`,
    id,
  );
}

export function setRailClaimStatus(d: DbLike, id: number, status: ClaimStatus): void {
  d.runSync('UPDATE rail_journeys SET claim_status = ? WHERE id = ?', status, id);
}

export function countRailJourneys(d: DbLike): number {
  return (d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM rail_journeys')?.n ?? 0);
}
