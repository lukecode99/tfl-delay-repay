// Journey lifecycle status tags (home v1.2 redesign). A journey carries a SET
// of tags, not one exclusive state — e.g. a journey can be eligible AND
// claimed AND rejected at once. Filters match "has this tag". Pure —
// node-testable (see test-status-tags.ts).
import type { ClaimStatus } from '../claims/db';

export type StatusTag = 'eligible' | 'claimed' | 'awaiting' | 'received' | 'rejected' | 'missed';
export type JourneyFilter = 'all' | StatusTag;

export const FILTER_ORDER: JourneyFilter[] = [
  'all', 'eligible', 'claimed', 'awaiting', 'received', 'rejected', 'missed',
];

export const FILTER_LABELS: Record<JourneyFilter, string> = {
  all: 'All',
  eligible: 'Eligible',
  claimed: 'Claimed',
  awaiting: 'Awaiting',
  received: 'Received',
  rejected: 'Rejected',
  missed: 'Missed',
};

export interface TagInput {
  eligible: boolean; // assessment verdict (if assessed)
  claimStatus: ClaimStatus | null; // null = never claimed
  daysLeft: number | null; // claim-window days left; negative = window closed
}

export function statusTags({ eligible, claimStatus, daysLeft }: TagInput): Set<StatusTag> {
  const tags = new Set<StatusTag>();
  if (eligible) tags.add('eligible');
  if (claimStatus != null) tags.add('claimed');
  if (claimStatus === 'claimed') tags.add('awaiting');
  if (claimStatus === 'paid') tags.add('received');
  if (claimStatus === 'rejected') tags.add('rejected');
  // Missed: was eligible, never claimed, and the claim window has closed.
  if (eligible && claimStatus == null && daysLeft != null && daysLeft < 0) tags.add('missed');
  return tags;
}

export function matchesFilter(tags: Set<StatusTag>, filter: JourneyFilter): boolean {
  return filter === 'all' || tags.has(filter);
}
