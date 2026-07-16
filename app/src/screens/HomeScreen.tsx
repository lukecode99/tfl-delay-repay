// Home v1.2 (front-screen redesign, 15-Jul): summary card with four tappable
// lifecycle stats that deep-link into the pre-filtered Journeys tab, the
// refresh/import actions, and a "needs attention" list of eligible unclaimed
// journeys still inside the claim window.
import React from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ClaimRecord } from '../claims/db';
import { claimTotals } from '../claims/stats';
import { claimDeadline } from '../eligibility/deadline';
import type { AssessmentMap } from '../eligibility/use-assessments';
import { formatGBP } from '../format';
import type { StoredJourney } from '../journeys/db';
import type { ImportOutcome } from '../journeys/import';
import type { OverchargeCandidate } from '../journeys/incomplete-fare';
import { shareRawStatements } from '../journeys/raw-export-io';
import { statusTags, type JourneyFilter } from '../journeys/status-tags';
import { colors, spacing } from '../theme';

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  /** Detected max-fare overcharges, keyed by journey id (computed in App). */
  overchargeById: Map<number, OverchargeCandidate>;
  claims: Map<number, ClaimRecord>;
  lastImport: ImportOutcome | null;
  refreshing: boolean;
  refreshNote: string | null;
  onRefreshPress: () => void;
  onImportPress: () => void;
  onSelect: (journey: StoredJourney) => void;
  onOpenJourneys: (filter: JourneyFilter) => void;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HomeScreen({
  journeys, assessments, overchargeById, claims, lastImport, refreshing, refreshNote,
  onRefreshPress, onImportPress, onSelect, onOpenJourneys,
}: Props) {
  const today = React.useMemo(todayISO, []);
  const totals = claimTotals([...claims.values()]);

  const { eligibleCount, missedCount, attention } = React.useMemo(() => {
    let eligible = 0, missed = 0;
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
      // Count from tags so the headline matches the Eligible chip exactly —
      // live overcharges count as eligible money too.
      if (tags.has('eligible')) eligible++;
      if (tags.has('missed')) missed++;
      else if (isEligible && !tags.has('claimed')) attn.push(j);
    }
    return { eligibleCount: eligible, missedCount: missed, attention: attn };
  }, [journeys, assessments, overchargeById, claims, today]);

  const onExportPress = React.useCallback(async () => {
    try {
      const shared = await shareRawStatements();
      if (!shared) {
        Alert.alert('Nothing to export yet', 'Tap "Refresh from TfL" first to pull your statements, then export.');
      }
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
  }, []);

  const stat = (label: string, value: string, filter: JourneyFilter, valueStyle?: object) => (
    <Pressable style={styles.stat} onPress={() => onOpenJourneys(filter)}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, valueStyle]}>
        {value}<Text style={styles.chevron}> ›</Text>
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>TfL Delay Repay</Text>

      <View style={styles.card}>
        <View style={styles.bigRow}>
          <Text style={styles.bigNumber}>{eligibleCount}</Text>
          <Text style={styles.bigUnit}>likely eligible · {journeys.length} journeys</Text>
        </View>
        <View style={styles.statRow}>
          {stat('Claimed', formatGBP(totals.claimedValue), 'claimed', { color: colors.good })}
          <View style={styles.sep} />
          {stat('Received', formatGBP(totals.paidValue), 'received')}
          <View style={styles.sep} />
          {stat('Awaiting', String(totals.openCount), 'awaiting', { color: colors.warn })}
          <View style={styles.sep} />
          {stat('Missed', String(missedCount), 'missed', { color: colors.textDim })}
        </View>
      </View>

      <Pressable
        style={[styles.refreshButton, refreshing && styles.refreshButtonBusy]}
        onPress={onRefreshPress}
        disabled={refreshing}
      >
        <Text style={styles.refreshButtonText}>{refreshing ? 'Checking TfL…' : 'Refresh from TfL'}</Text>
      </Pressable>

      <View style={styles.linkRow}>
        <Pressable style={styles.link} onPress={onImportPress}>
          <Text style={styles.linkText}>⬇ Import CSV</Text>
        </Pressable>
        <Pressable style={styles.link} onPress={onExportPress}>
          <Text style={styles.linkText}>⬆ Export statements</Text>
        </Pressable>
      </View>

      {refreshNote && <Text style={styles.note}>{refreshNote}</Text>}
      {lastImport && (
        <Text style={styles.note}>
          {lastImport.fileName}: {lastImport.inserted} new
          {lastImport.upgraded > 0 ? `, ${lastImport.upgraded} fixed` : ''}
          {lastImport.duplicates > 0 ? `, ${lastImport.duplicates} duplicates skipped` : ''}
          {lastImport.incomplete > 0 ? `, ${lastImport.incomplete} incomplete` : ''}
        </Text>
      )}

      <Text style={styles.sectionLabel}>
        NEEDS ATTENTION · {attention.length}
      </Text>
      <FlatList
        data={attention}
        keyExtractor={j => String(j.id)}
        style={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nothing waiting on you — eligible journeys you haven't claimed yet will appear here.
          </Text>
        }
        renderItem={({ item }) => {
          const a = assessments.get(item.id);
          return (
            <Pressable style={styles.row} onPress={() => onSelect(item)}>
              <View style={styles.stripe} />
              <View style={styles.rowMain}>
                <Text style={styles.route} numberOfLines={1}>
                  {item.origin} → {item.destination ?? '?'}
                </Text>
                <Text style={styles.meta}>
                  {item.date} · {item.tapInTime ?? '--:--'}
                  {a?.overageMinutes != null ? ` · ${a.overageMinutes} min over` : ''}
                </Text>
              </View>
              {a?.refundValue != null && <Text style={styles.amount}>{formatGBP(a.refundValue)}</Text>}
              <View style={styles.claimButton}>
                <Text style={styles.claimButtonText}>Claim</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginBottom: spacing.m },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: spacing.m,
  },
  bigRow: { flexDirection: 'row', alignItems: 'baseline' },
  bigNumber: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  bigUnit: { color: colors.textDim, fontSize: 15, fontWeight: '600', marginLeft: spacing.s },
  statRow: { flexDirection: 'row', marginTop: spacing.m },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { color: colors.textDim, fontSize: 12, marginBottom: 3 },
  statValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  chevron: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
  sep: { width: 1, backgroundColor: colors.cardBorder },
  refreshButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 14,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.m,
  },
  refreshButtonBusy: { opacity: 0.6 },
  refreshButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  linkRow: { flexDirection: 'row', marginTop: spacing.s },
  link: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 11,
    paddingVertical: spacing.s + 3,
    marginHorizontal: 2,
  },
  linkText: { color: colors.accentBright, fontSize: 14, fontWeight: '600' },
  note: { color: colors.text, fontSize: 13, marginTop: spacing.s },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  list: { flex: 1 },
  empty: { color: colors.textDim, fontSize: 13, marginTop: spacing.s },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.m,
    marginBottom: spacing.s,
  },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 3, backgroundColor: colors.bad, marginRight: spacing.m },
  rowMain: { flex: 1, marginRight: spacing.s },
  route: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.textDim, fontSize: 12.5, marginTop: 2 },
  amount: { color: colors.good, fontSize: 15, fontWeight: '800', marginRight: spacing.s },
  claimButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 10,
    paddingVertical: spacing.s + 1,
    paddingHorizontal: spacing.m - 1,
  },
  claimButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
