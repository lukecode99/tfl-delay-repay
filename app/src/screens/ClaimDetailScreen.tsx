// TfL-5: claim detail — the evidence behind a verdict: expected vs actual
// duration, disruption from the ledger, refund value, days left to claim.
import React, { useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getClaim, reopenClaim, setClaimOutcome, unmarkClaimed } from '../claims/db';
import { claimDeadline } from '../eligibility/deadline';
import type { Assessment } from '../eligibility/engine';
import { formatDay, formatGBP } from '../format';
import type { StoredJourney } from '../journeys/db';
import { colors, lineColors, spacing } from '../theme';

interface Props {
  journey: StoredJourney;
  assessment: Assessment | undefined;
  onBack: () => void;
  onFileClaim: () => void;
}

const REASON_TEXT: Record<string, string> = {
  'incomplete': 'Missing tap-out — duration can’t be measured from the statement.',
  'unresolved-station': 'Station name in the statement didn’t match the TfL network dataset.',
  'no-timing': 'Journey Planner couldn’t route this station pair.',
  'under-threshold': 'Delay is under the refund threshold for this route.',
  'no-disruption': 'The disruption ledger covered this window and the plausible lines were running normally.',
};

const CONFIDENCE_TEXT: Record<string, string> = {
  high: 'A significant disruption was logged on a plausible line while you were travelling.',
  medium: 'Disruption was logged on a plausible line during or near your journey window.',
  low: 'The delay clears the threshold but the ledger can’t fully corroborate it (minor/nearby disruption or a collector gap).',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
    </View>
  );
}

export default function ClaimDetailScreen({ journey, assessment: a, onBack, onFileClaim }: Props) {
  const [claim, setClaim] = useState(() => getClaim(journey.id));
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { deadline, daysLeft } = claimDeadline(journey.date, todayStr);
  const eligible = a?.status === 'eligible';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: spacing.xl }}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Journeys</Text>
      </Pressable>

      <Text style={styles.route}>{journey.origin} → {journey.destination ?? '?'}</Text>
      <Text style={styles.when}>
        {formatDay(journey.date)} · {journey.tapInTime ?? '--:--'}–{journey.tapOutTime ?? '--:--'}
        {journey.incomplete ? ' · ⚠ incomplete' : ''}
      </Text>

      {/* Verdict banner */}
      {!a ? (
        <View style={[styles.banner, styles.bannerDim]}>
          <Text style={styles.bannerTitle}>Assessing…</Text>
        </View>
      ) : eligible ? (
        <View style={[styles.banner, styles.bannerGood]}>
          <Text style={styles.bannerTitle}>
            Likely eligible{a.refundValue != null ? ` · ≈${formatGBP(a.refundValue)}` : ''}
          </Text>
          <Text style={styles.bannerBody}>
            Confidence {a.confidence}: {CONFIDENCE_TEXT[a.confidence ?? 'low']}
          </Text>
        </View>
      ) : (
        <View style={[styles.banner, styles.bannerDim]}>
          <Text style={styles.bannerTitle}>
            {a.status === 'not-eligible' ? 'Not eligible' : 'Can’t assess'}
          </Text>
          <Text style={styles.bannerBody}>{REASON_TEXT[a.reasonCode] ?? a.reasonCode}</Text>
        </View>
      )}

      {/* Duration evidence */}
      {a?.actualMinutes != null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Duration</Text>
          <Row label="Expected" value={`${a.expectedMinutes} min`} />
          <Row label="Actual (tap to tap)" value={`${a.actualMinutes} min`} />
          <Row label="Delay" value={`${a.overageMinutes} min`} />
          <Row label="Refund threshold" value={`${a.thresholdMinutes} min for this route`} />
        </View>
      )}

      {/* Disruption evidence from the ledger */}
      {a?.disruption && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Disruption logged</Text>
          <View style={styles.lineRow}>
            <View style={[styles.lineDot, { backgroundColor: lineColors[a.disruption.line] ?? colors.textDim }]} />
            <Text style={styles.lineName}>{a.disruption.line.replace(/-/g, ' ')}</Text>
            <Text style={styles.severity}>{a.disruption.description}</Text>
          </View>
          {a.disruption.reason && <Text style={styles.reason}>{a.disruption.reason.trim()}</Text>}
          <Text style={styles.loggedAt}>Logged {a.disruption.ts.slice(0, 16).replace('T', ' ')} UTC</Text>
        </View>
      )}

      {/* Fare / refund */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Refund value</Text>
        {journey.charge != null ? (
          <Row label="Fare charged (statement)" value={formatGBP(journey.charge)} />
        ) : a?.refundValue != null ? (
          <Row label="Estimated fare (zone matrix)" value={formatGBP(a.refundValue)} />
        ) : (
          <Text style={styles.dimText}>No charge on the statement and the pair is outside the fare matrix.</Text>
        )}
      </View>

      {/* Claim window */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Claim window</Text>
        {daysLeft >= 0 ? (
          <>
            <Text style={[styles.daysLeft, daysLeft <= 5 && { color: colors.warn }]}>
              {daysLeft === 0 ? 'Last day to claim' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
            </Text>
            <Text style={styles.dimText}>Claims close {formatDay(deadline)} (28 days after travel).</Text>
          </>
        ) : (
          <>
            <Text style={[styles.daysLeft, { color: colors.bad }]}>Expired</Text>
            <Text style={styles.dimText}>The 28-day window closed on {formatDay(deadline)}.</Text>
          </>
        )}
      </View>

      {claim ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Claim filed</Text>
          {claim.status === 'paid' ? (
            <>
              <Text style={styles.claimedText}>
                ✓ Paid{claim.paidAmount != null ? ` ${formatGBP(claim.paidAmount)}` : ''}
                {claim.resolvedAt ? ` · ${formatDay(claim.resolvedAt.slice(0, 10))}` : ''}
              </Text>
              <Pressable onPress={() => { reopenClaim(journey.id); setClaim(getClaim(journey.id)); }} hitSlop={8}>
                <Text style={styles.unmark}>Not right? Reopen</Text>
              </Pressable>
            </>
          ) : claim.status === 'rejected' ? (
            <>
              <Text style={styles.rejectedText}>
                ✗ Rejected by TfL{claim.resolvedAt ? ` · ${formatDay(claim.resolvedAt.slice(0, 10))}` : ''}
              </Text>
              <Pressable onPress={() => { reopenClaim(journey.id); setClaim(getClaim(journey.id)); }} hitSlop={8}>
                <Text style={styles.unmark}>Not right? Reopen</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.claimedText}>✓ Marked claimed on {formatDay(claim.claimedAt.slice(0, 10))}</Text>
              <Text style={styles.dimText}>When TfL responds, record the outcome:</Text>
              <View style={styles.outcomeRow}>
                <Pressable
                  style={[styles.outcomeButton, styles.outcomePaid]}
                  onPress={() => {
                    const fallback = claim.expectedValue ?? a?.refundValue ?? null;
                    Alert.prompt(
                      'Amount received',
                      'What did TfL refund? (£)',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Save',
                          onPress: (value?: string) => {
                            const n = Number(value?.replace(/[£,\s]/g, ''));
                            setClaimOutcome(journey.id, 'paid', Number.isFinite(n) && n >= 0 ? n : fallback);
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            setClaim(getClaim(journey.id));
                          },
                        },
                      ],
                      'plain-text',
                      fallback != null ? fallback.toFixed(2) : '',
                      'decimal-pad',
                    );
                  }}
                >
                  <Text style={styles.outcomePaidText}>Paid ✓</Text>
                </Pressable>
                <Pressable
                  style={[styles.outcomeButton, styles.outcomeRejected]}
                  onPress={() => { setClaimOutcome(journey.id, 'rejected'); setClaim(getClaim(journey.id)); }}
                >
                  <Text style={styles.outcomeRejectedText}>Rejected ✗</Text>
                </Pressable>
              </View>
              <Pressable onPress={() => { unmarkClaimed(journey.id); setClaim(null); }} hitSlop={8}>
                <Text style={styles.unmark}>Not right? Unmark</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : eligible && daysLeft >= 0 ? (
        <>
          <Pressable style={styles.fileButton} onPress={onFileClaim}>
            <Text style={styles.fileButtonText}>File this claim on tfl.gov.uk</Text>
          </Pressable>
          <Text style={styles.footer}>
            Opens TfL's service-delay-refund flow with your journey details ready to fill or copy.
            You sign in and submit yourself — this app never stores TfL credentials or submits claims for you.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  back: { color: colors.accentBright, fontSize: 17, marginBottom: spacing.m },
  route: { color: colors.text, fontSize: 24, fontWeight: '700' },
  when: { color: colors.textDim, fontSize: 14, marginTop: spacing.xs, marginBottom: spacing.m },
  banner: { borderRadius: 12, padding: spacing.m, marginBottom: spacing.m },
  bannerGood: { backgroundColor: colors.good },
  bannerDim: { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1 },
  bannerTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  bannerBody: { color: colors.text, fontSize: 13, marginTop: spacing.xs, opacity: 0.9 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  cardTitle: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: spacing.s,
  },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  kvLabel: { color: colors.textDim, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  lineRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  lineDot: { width: 12, height: 12, borderRadius: 6, marginRight: spacing.s },
  lineName: { color: colors.text, fontSize: 15, fontWeight: '700', textTransform: 'capitalize', flex: 1 },
  severity: { color: colors.warn, fontSize: 14, fontWeight: '700' },
  reason: { color: colors.text, fontSize: 14, marginTop: spacing.xs, lineHeight: 20 },
  loggedAt: { color: colors.textDim, fontSize: 12, marginTop: spacing.s },
  dimText: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  daysLeft: { color: colors.good, fontSize: 20, fontWeight: '800', marginBottom: spacing.xs },
  fileButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
  },
  fileButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  claimedText: { color: colors.good, fontSize: 15, fontWeight: '700', marginBottom: spacing.s },
  rejectedText: { color: colors.bad, fontSize: 15, fontWeight: '700', marginBottom: spacing.s },
  outcomeRow: { flexDirection: 'row', marginTop: spacing.s, marginBottom: spacing.s },
  outcomeButton: {
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
    marginRight: spacing.s,
  },
  outcomePaid: { backgroundColor: colors.good },
  outcomePaidText: { color: '#04220F', fontSize: 14, fontWeight: '800' },
  outcomeRejected: { borderColor: colors.bad, borderWidth: 1 },
  outcomeRejectedText: { color: colors.bad, fontSize: 14, fontWeight: '800' },
  unmark: { color: colors.textDim, fontSize: 13, textDecorationLine: 'underline' },
  footer: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginTop: spacing.s },
});
