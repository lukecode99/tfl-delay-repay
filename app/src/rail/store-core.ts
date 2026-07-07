// Rail journey store — pure SQL over DbLike, mirroring journeys/store-core.ts
// so the DB logic is testable under plain node (node:sqlite adapter).
import type { DbLike } from '../journeys/store-core.ts';

export type RailOperator = 'avanti' | 'southern' | 'gtr';

export interface RailJourney {
  id: number;
  originCrs: string;
  destinationCrs: string;
  departureDate: string;      // YYYY-MM-DD
  scheduledDepart: string;    // HH:MM
  actualDepart: string | null;
  scheduledArrive: string | null;
  actualArrive: string | null;
  delayMinutes: number | null;
  operator: RailOperator;
  singleFare: number | null;  // pounds
  claimedAt: string | null;   // ISO timestamp
  importedAt: string;         // ISO timestamp
}

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
      single_fare REAL,
      claimed_at TEXT,
      imported_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_journeys_dedupe
      ON rail_journeys (origin_crs, destination_crs, departure_date, scheduled_depart, operator);
    CREATE INDEX IF NOT EXISTS idx_rail_journeys_date ON rail_journeys (departure_date);
  `);
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
    singleFare: (r.single_fare as number | null) ?? null,
    claimedAt: (r.claimed_at as string | null) ?? null,
    importedAt: r.imported_at as string,
  };
}

export function insertRailJourney(
  d: DbLike,
  j: Omit<RailJourney, 'id'>,
  now: string,
): number | null {
  const res = d.runSync(
    `INSERT OR IGNORE INTO rail_journeys
       (origin_crs, destination_crs, departure_date, scheduled_depart,
        actual_depart, scheduled_arrive, actual_arrive, delay_minutes,
        operator, single_fare, claimed_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    j.originCrs, j.destinationCrs, j.departureDate, j.scheduledDepart,
    j.actualDepart, j.scheduledArrive, j.actualArrive, j.delayMinutes,
    j.operator, j.singleFare, j.claimedAt, now,
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
  d.runSync('UPDATE rail_journeys SET claimed_at = ? WHERE id = ?', at, id);
}

export function unmarkRailClaimed(d: DbLike, id: number): void {
  d.runSync('UPDATE rail_journeys SET claimed_at = NULL WHERE id = ?', id);
}

export function countRailJourneys(d: DbLike): number {
  return (d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM rail_journeys')?.n ?? 0);
}
