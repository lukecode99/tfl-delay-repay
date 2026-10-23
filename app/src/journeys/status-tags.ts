// Journey lifecycle status tags (home v1.2 redesign). A journey carries a SET
// of tags, not one exclusive state — e.g. a journey can be eligible AND
// claimed AND rejected at once. Filters match "has this tag". Pure —
// node-testable (see test-status-tags.ts).
import type { ClaimStatus } from '../claims/db';

export type StatusTag = 'eligible' | 'overcharged' | 'claimed' | 'awaiting' | 'received' | 'rejected' | 'missed';
export type JourneyFilter = 'all' | StatusTag;

export const FILTER_ORDER: JourneyFilter[] = [
  'all', 'eligible', 'overcharged', 'claimed', 'awaiting', 'received', 'rejected', 'missed',
];

export const FILTER_LABELS: Record<JourneyFilter, string> = {
  all: 'All',
  eligible: 'Eligible',
  overcharged: 'Overcharged',
  claimed: 'Claimed',
  awaiting: 'Awaiting',
  received: 'Received',
  rejected: 'Rejected',
  missed: 'Missed',
};

// TfL-35: TfL pays delay-repay within days and never notifies a rejection on
// the statement — and the online Refund-history page only carries recent
// claims, so old outcomes can't be scraped. Luke's rule: a claim still
// unpaid 60 days after submission is treated as rejected. Derived, not
// persisted — if a (late) payment ever arrives, 'paid' still wins because the
// stored status flips to 'paid' and this age-out no longer applies.
export const REJECT_AFTER_DAYS = 60;

/** Whole days between an ISO claim timestamp and a YYYY-MM-DD "today". */
export function claimAgeDays(claimedAt: string, today: string): number {
  const a = new Date(claimedAt.slice(0, 10)).getTime();
  const b = new Date(today).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

export interface TagInput {
  eligible: boolean; // assessment verdict (if assessed)
  /** Detected max-fare overcharge still inside TfL's 8-week window (claimable
   *  OR pending-auto — recoverable money either way, so it also counts as
   *  eligible even while the 48h auto-refund wait runs). */
  overcharged?: boolean;
  claimStatus: ClaimStatus | null; // null = never claimed
  claimedAt?: string | null; // ISO; with `today`, ages an unpaid claim to rejected
  today?: string | null; // YYYY-MM-DD; enables the 60-day auto-reject
  daysLeft: number | null; // claim-window days left; negative = window closed
}

export function statusTags({ eligible, overcharged, claimStatus, claimedAt, today, daysLeft }: TagInput): Set<StatusTag> {
  const tags = new Set<StatusTag>();
  // A claim marked 'claimed' that TfL hasn't paid within the window is aged
  // out to rejected (TfL-35). Needs both claimedAt and today, so callers that
  // omit them keep the old behaviour.
  const agedOut = claimStatus === 'claimed' && claimedAt != null && today != null
    && claimAgeDays(claimedAt, today) >= REJECT_AFTER_DAYS;
  if (eligible || overcharged) tags.add('eligible');
  if (overcharged) tags.add('overcharged');
  if (claimStatus != null) tags.add('claimed');
  if (claimStatus === 'claimed' && !agedOut) tags.add('awaiting');
  if (claimStatus === 'paid') tags.add('received');
  if (claimStatus === 'rejected' || agedOut) tags.add('rejected');
  // Missed: was eligible, never claimed, and the claim window has closed.
  if (eligible && claimStatus == null && daysLeft != null && daysLeft < 0) tags.add('missed');
  return tags;
}

export function matchesFilter(tags: Set<StatusTag>, filter: JourneyFilter): boolean {
  return filter === 'all' || tags.has(filter);
}
