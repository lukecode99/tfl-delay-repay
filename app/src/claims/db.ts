// Claim tracking store (TfL-6): one row per journey the user has marked as
// claimed on the TfL site. Submission itself always happens on tfl.gov.uk —
// this table only records that the user did it.
import { openJourneyDb } from '../journeys/db';

export interface ClaimRecord {
  journeyId: number;
  claimedAt: string; // ISO
}

let ready = false;
function db() {
  const d = openJourneyDb();
  if (!ready) {
    d.execSync(`
      CREATE TABLE IF NOT EXISTS claims (
        journey_id INTEGER PRIMARY KEY,
        claimed_at TEXT NOT NULL
      );
    `);
    ready = true;
  }
  return d;
}

export function markClaimed(journeyId: number): ClaimRecord {
  const claimedAt = new Date().toISOString();
  db().runSync('INSERT OR REPLACE INTO claims (journey_id, claimed_at) VALUES (?, ?)', journeyId, claimedAt);
  return { journeyId, claimedAt };
}

export function unmarkClaimed(journeyId: number): void {
  db().runSync('DELETE FROM claims WHERE journey_id = ?', journeyId);
}

export function getClaim(journeyId: number): ClaimRecord | null {
  const row = db().getFirstSync<{ claimed_at: string }>(
    'SELECT claimed_at FROM claims WHERE journey_id = ?', journeyId,
  );
  return row ? { journeyId, claimedAt: row.claimed_at } : null;
}

export function listClaims(): ClaimRecord[] {
  return db().getAllSync<any>('SELECT journey_id, claimed_at FROM claims')
    .map(r => ({ journeyId: r.journey_id, claimedAt: r.claimed_at }));
}
