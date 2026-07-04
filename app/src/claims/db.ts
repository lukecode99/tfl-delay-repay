// Claim tracking store (TfL-6/7): one row per journey the user has claimed on
// the TfL site, now with lifecycle status — claimed → paid / rejected.
// Submission itself always happens on tfl.gov.uk — this table only records
// what the user did and what came back.
import { openJourneyDb } from '../journeys/db';

export type ClaimStatus = 'claimed' | 'paid' | 'rejected';

export interface ClaimRecord {
  journeyId: number;
  claimedAt: string; // ISO
  status: ClaimStatus;
  expectedValue: number | null; // refund estimate captured when marked claimed
  paidAmount: number | null; // actual amount received (status = paid)
  resolvedAt: string | null; // ISO, when marked paid/rejected
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
    // TfL-7 columns; ALTER is idempotent-by-check so TfL-6 installs upgrade in place.
    const cols = d.getAllSync<{ name: string }>('PRAGMA table_info(claims)').map(c => c.name);
    if (!cols.includes('status')) d.execSync("ALTER TABLE claims ADD COLUMN status TEXT NOT NULL DEFAULT 'claimed'");
    if (!cols.includes('expected_value')) d.execSync('ALTER TABLE claims ADD COLUMN expected_value REAL');
    if (!cols.includes('paid_amount')) d.execSync('ALTER TABLE claims ADD COLUMN paid_amount REAL');
    if (!cols.includes('resolved_at')) d.execSync('ALTER TABLE claims ADD COLUMN resolved_at TEXT');
    ready = true;
  }
  return d;
}

const fromRow = (r: any): ClaimRecord => ({
  journeyId: r.journey_id,
  claimedAt: r.claimed_at,
  status: (r.status ?? 'claimed') as ClaimStatus,
  expectedValue: r.expected_value ?? null,
  paidAmount: r.paid_amount ?? null,
  resolvedAt: r.resolved_at ?? null,
});

const SELECT = 'SELECT journey_id, claimed_at, status, expected_value, paid_amount, resolved_at FROM claims';

export function markClaimed(journeyId: number, expectedValue?: number | null): ClaimRecord {
  const claimedAt = new Date().toISOString();
  db().runSync(
    "INSERT OR REPLACE INTO claims (journey_id, claimed_at, status, expected_value) VALUES (?, ?, 'claimed', ?)",
    journeyId, claimedAt, expectedValue ?? null,
  );
  return { journeyId, claimedAt, status: 'claimed', expectedValue: expectedValue ?? null, paidAmount: null, resolvedAt: null };
}

/** claimed → paid/rejected. `paidAmount` only meaningful for 'paid'. */
export function setClaimOutcome(journeyId: number, status: 'paid' | 'rejected', paidAmount?: number | null): void {
  db().runSync(
    'UPDATE claims SET status = ?, paid_amount = ?, resolved_at = ? WHERE journey_id = ?',
    status, status === 'paid' ? paidAmount ?? null : null, new Date().toISOString(), journeyId,
  );
}

/** paid/rejected → back to claimed (mis-tap recovery). */
export function reopenClaim(journeyId: number): void {
  db().runSync("UPDATE claims SET status = 'claimed', paid_amount = NULL, resolved_at = NULL WHERE journey_id = ?", journeyId);
}

export function unmarkClaimed(journeyId: number): void {
  db().runSync('DELETE FROM claims WHERE journey_id = ?', journeyId);
}

export function getClaim(journeyId: number): ClaimRecord | null {
  const row = db().getFirstSync<any>(`${SELECT} WHERE journey_id = ?`, journeyId);
  return row ? fromRow(row) : null;
}

export function listClaims(): ClaimRecord[] {
  return db().getAllSync<any>(SELECT).map(fromRow);
}
