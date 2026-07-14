// TfL-5/7: journey list grouped by day, eligible journeys badged with the
// estimated refund, lifetime claim totals up top.
import React from 'react';
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { shareRawStatements } from '../journeys/raw-export-io';
import type { ClaimRecord } from '../claims/db';
import { claimTotals } from '../claims/stats';
import type { Assessment } from '../eligibility/engine';
import type { AssessmentMap } from '../eligibility/use-assessments';
import { formatGBP, groupByDay } from '../format';
import type { StoredJourney } from '../journeys/db';
import type { ImportOutcome } from '../journeys/import';
import { detectOvercharges, totalDisputableRefund, claimableOvercharges } from '../journeys/incomplete-fare';
import { journeyKey } from '../journeys/parse';
import { colors, spacing } from '../theme';

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  claims: Map<number, ClaimRecord>;
  lastImport: ImportOutcome | null;
  onImportPress: () => void;
  onSelect: (journey: StoredJourney) => void;
  // TfL-10: auto-fetch through the signed-in TfL session
  onRefreshPress: () => void;
  refreshing: boolean;
  refreshNote: string | null;
}

function Badge({ assessment, claim }: { assessment: Assessment | undefined; claim: ClaimRecord | undefined }) {
  if (claim?.status === 'paid') {
    return (
      <Text style={styles.badgeClaimed}>
        ✓ paid{claim.paidAmount != null ? ` ${formatGBP(claim.paidAmount)}` : ''}
      </Text>
    );
  }
  if (claim?.status === 'rejected') return <Text style={styles.badgeRejected}>✗ rejected</Text>;
  if (claim) return <Text style={styles.badgeClaimed}>✓ claimed</Text>;
  if (!assessment) return <Text style={styles.badgePending}>…</Text>;
  if (assessment.status === 'eligible') {
    const value = assessment.refundValue != null ? `≈${formatGBP(assessment.refundValue)}` : 'refund';
    return (
      <View style={styles.badgeEligible}>
        <Text style={styles.badgeEligibleText}>{value}</Text>
        <Text style={styles.badgeConfidence}>{assessment.confidence}</Text>
      </View>
    );
  }
  if (assessment.reasonCode === 'incomplete') return <Text style={styles.badgeWarn}>⚠</Text>;
  return null; // not eligible / not assessable — keep rows quiet
}

export default function JourneysScreen({ journeys, assessments, claims, lastImport, onImportPress, onSelect, onRefreshPress, refreshing, refreshNote }: Props) {
  const sections = groupByDay(journeys);
  const eligibleCount = journeys.filter(j => assessments.get(j.id)?.status === 'eligible').length;
  const totals = claimTotals([...claims.values()]);

  // TfL-21/22: missing tap-outs charged above the user's usual fare for that
  // origin — a disputable max-fare overcharge. Learned from their own history.
  // We pull deep history to learn routes, but only surface overcharges still
  // inside TfL's 8-week claim window and past the 48h auto-refund wait.
  const asOfISO = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const allOvercharges = React.useMemo(
    () => detectOvercharges(journeys, { asOfISO }),
    [journeys, asOfISO],
  );
  const overcharges = React.useMemo(() => claimableOvercharges(allOvercharges), [allOvercharges]);
  const disputable = totalDisputableRefund(overcharges);
  const pendingAutoCount = allOvercharges.filter(c => c.claimStatus === 'pending-auto').length;
  const expiredCount = allOvercharges.filter(c => c.claimStatus === 'expired').length;
  const journeyByKey = React.useMemo(() => {
    const m = new Map<string, StoredJourney>();
    for (const j of journeys) m.set(journeyKey(j), j);
    return m;
  }, [journeys]);

  // TfL-23: share the raw TfL statements captured on the last refresh.
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>TfL Delay Repay</Text>
      <Text style={styles.subtitle}>
        {journeys.length} journeys
        {eligibleCount > 0 ? ` · ${eligibleCount} likely eligible` : ''}
      </Text>
      {totals.claimedCount > 0 && (
        <Text style={styles.totals}>
          Claimed {formatGBP(totals.claimedValue)} · received {formatGBP(totals.paidValue)}
          {totals.openCount > 0 ? ` · ${totals.openCount} awaiting TfL` : ''}
        </Text>
      )}

      <View style={styles.buttonRow}>
        <Pressable style={[styles.importButton, styles.buttonRowItem]} onPress={onImportPress}>
          <Text style={styles.importButtonText}>Import CSV</Text>
        </Pressable>
        <Pressable
          style={[styles.refreshButton, styles.buttonRowItem, refreshing && styles.refreshButtonBusy]}
          onPress={onRefreshPress}
          disabled={refreshing}
        >
          <Text style={styles.refreshButtonText}>{refreshing ? 'Checking TfL…' : 'Refresh from TfL'}</Text>
        </Pressable>
      </View>
      <Text style={styles.importHint}>
        Journeys update when you open the app — you can watch the TfL page as it works, and sign
        in right there if asked. You can also share a TfL CSV statement to this app from Files / Mail.
      </Text>
      <Pressable onPress={onExportPress} hitSlop={8}>
        <Text style={styles.exportLink}>⬆ Export raw statements (share the CSVs from your last refresh)</Text>
      </Pressable>
      {refreshNote && <Text style={styles.importSummary}>{refreshNote}</Text>}
      {lastImport && (
        <Text style={styles.importSummary}>
          {lastImport.fileName}: {lastImport.inserted} new
          {lastImport.upgraded > 0 ? `, ${lastImport.upgraded} fixed` : ''}
          {lastImport.duplicates > 0 ? `, ${lastImport.duplicates} duplicates skipped` : ''}
          {lastImport.incomplete > 0 ? `, ${lastImport.incomplete} incomplete` : ''}
          {lastImport.parsed.skipped > 0 ? ` (${lastImport.parsed.skipped} non-rail rows ignored)` : ''}
        </Text>
      )}

      {allOvercharges.length > 0 && (
        <View style={styles.disputeCard}>
          <Text style={styles.disputeTitle}>
            ⚠ {overcharges.length} claimable max-fare {overcharges.length === 1 ? 'overcharge' : 'overcharges'}
            {disputable > 0 ? ` · ${formatGBP(disputable)} disputable` : ''}
          </Text>
          {overcharges.length > 0 && (
            <Text style={styles.disputeHint}>
              Missing tap-out charged above your usual fare for that route. Tap to review, then dispute with TfL.
            </Text>
          )}
          {pendingAutoCount > 0 && (
            <Text style={styles.disputeHint}>
              {pendingAutoCount} more just charged — TfL usually auto-refunds these; give it 48h before claiming.
            </Text>
          )}
          {expiredCount > 0 && (
            <Text style={styles.disputeHint}>
              {expiredCount} past TfL's 8-week claim window — no longer refundable.
            </Text>
          )}
          {overcharges.slice(0, 5).map(c => {
            const match = journeyByKey.get(c.journeyKey);
            return (
              <Pressable
                key={c.journeyKey}
                style={styles.disputeRow}
                disabled={!match}
                onPress={() => match && onSelect(match)}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.disputeRoute} numberOfLines={1}>
                    {c.origin} → {c.likelyDestination ?? '?'}
                  </Text>
                  <Text style={styles.disputeMeta}>
                    {c.date} · charged {formatGBP(c.charged)} vs usual {formatGBP(c.usualFare)} · {c.confidence}
                  </Text>
                </View>
                <Text style={styles.disputeRefund}>+{formatGBP(c.estimatedRefund)}</Text>
              </Pressable>
            );
          })}
          {overcharges.length > 5 && (
            <Text style={styles.disputeHint}>…and {overcharges.length - 5} more.</Text>
          )}
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={j => String(j.id)}
        style={styles.list}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>No journeys imported yet.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.dayHeader}>{section.title}</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onSelect(item)}>
            <View style={styles.rowMain}>
              <Text style={styles.route} numberOfLines={1}>
                {item.origin} → {item.destination ?? '?'}
              </Text>
              <Text style={styles.meta}>
                {item.tapInTime ?? '--:--'}–{item.tapOutTime ?? '--:--'}
                {item.charge != null ? `  ·  ${formatGBP(item.charge)}` : ''}
              </Text>
            </View>
            <Badge assessment={assessments.get(item.id)} claim={claims.get(item.id)} />
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.xs },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: spacing.m },
  totals: { color: colors.good, fontSize: 14, fontWeight: '700', marginTop: -spacing.s, marginBottom: spacing.m },
  buttonRow: { flexDirection: 'row' },
  buttonRowItem: { flex: 1 },
  importButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
    marginRight: spacing.s,
  },
  importButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  refreshButton: {
    backgroundColor: colors.card,
    borderColor: colors.accentBright,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
  },
  refreshButtonBusy: { opacity: 0.6 },
  refreshButtonText: { color: colors.accentBright, fontSize: 16, fontWeight: '700' },
  importHint: { color: colors.textDim, fontSize: 12, marginTop: spacing.xs },
  exportLink: { color: colors.accentBright, fontSize: 12, fontWeight: '600', marginTop: spacing.s },
  importSummary: { color: colors.text, fontSize: 13, marginTop: spacing.s },
  list: { flex: 1, marginTop: spacing.m },
  empty: { color: colors.textDim, fontSize: 14, marginTop: spacing.m },
  disputeCard: {
    backgroundColor: colors.card,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginTop: spacing.m,
  },
  disputeTitle: { color: colors.warn, fontSize: 15, fontWeight: '800' },
  disputeHint: { color: colors.textDim, fontSize: 12, marginTop: spacing.xs },
  disputeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    paddingTop: spacing.s,
    marginTop: spacing.s,
  },
  disputeRoute: { color: colors.text, fontSize: 14, fontWeight: '600' },
  disputeMeta: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  disputeRefund: { color: colors.good, fontSize: 14, fontWeight: '800', marginLeft: spacing.s },
  dayHeader: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.m,
    marginBottom: spacing.s,
  },
  rowMain: { flex: 1, marginRight: spacing.s },
  route: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  badgePending: { color: colors.textDim, fontSize: 15, marginRight: spacing.s },
  badgeClaimed: { color: colors.good, fontSize: 13, fontWeight: '700', marginRight: spacing.s },
  badgeRejected: { color: colors.bad, fontSize: 13, fontWeight: '700', marginRight: spacing.s },
  badgeWarn: { color: colors.warn, fontSize: 15, marginRight: spacing.s },
  badgeEligible: {
    backgroundColor: colors.good,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 3,
    alignItems: 'center',
    marginRight: spacing.s,
  },
  badgeEligibleText: { color: '#04220F', fontSize: 13, fontWeight: '800' },
  badgeConfidence: { color: '#04220F', fontSize: 9, fontWeight: '600', textTransform: 'uppercase' },
  chevron: { color: colors.textDim, fontSize: 20 },
});
