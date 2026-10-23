// Pure helper for HomeScreen's "needs attention" list. Extracted from the
// useMemo body so the predicate is testable. A journey belongs in the list
// when it is actionable: eligible (delay-repay OR active overcharge), within
// its claim window, and not yet marked claimed.
//
// The bug this fixed: the inline predicate used `isEligible` (delay-repay
// only) while the headline count used `tags.has('eligible')` (delay-repay
// OR overcharge). statusTags adds the 'eligible' tag for both, so the
// headline counted overcharge journeys but the list below never showed them.
//
// node --experimental-strip-types src/journeys/test-home-stats.ts
import { claimDeadline } from '../eligibility/deadline.ts';
import type { AssessmentMap } from '../eligibility/use-assessments';
import type { ClaimRecord } from '../claims/db';
import type { StoredJourney } from './db';
import type { OverchargeCandidate } from './incomplete-fare';
import { statusTags } from './status-tags.ts';

export function attentionList(
  journeys: StoredJourney[],
  assessments: AssessmentMap,
  overchargeById: Map<number, OverchargeCandidate>,
  claims: Map<number, ClaimRecord>,
  today: string,
): StoredJourney[] {
  const attn: StoredJourney[] = [];
  for (const j of journeys) {
    const isEligible = assessments.get(j.id)?.status === 'eligible';
    const oc = overchargeById.get(j.id);
    const { daysLeft } = claimDeadline(j.date, today);
    const tags = statusTags({
      eligible: isEligible,
      overcharged: oc != null && oc.claimStatus !== 'expired',
      claimStatus: claims.get(j.id)?.status ?? null,
      daysLeft,
    });
    // 'missed' means past the delay-repay window — exclude from actionable list.
    // 'eligible' is set by statusTags for both delay-repay and active overcharges.
    if (!tags.has('missed') && tags.has('eligible') && !tags.has('claimed')) {
      attn.push(j);
    }
  }
  return attn;
}
