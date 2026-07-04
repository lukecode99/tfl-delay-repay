// TfL-5/7: journey list grouped by day, eligible journeys badged with the
// estimated refund, lifetime claim totals up top.
import React from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import type { ClaimRecord } from '../claims/db';
import { claimTotals } from '../claims/stats';
import type { Assessment } from '../eligibility/engine';
import type { AssessmentMap } from '../eligibility/use-assessments';
import { formatGBP, groupByDay } from '../format';
import type { StoredJourney } from '../journeys/db';
import type { ImportOutcome } from '../journeys/import';
import { colors, spacing } from '../theme';

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  claims: Map<number, ClaimRecord>;
  lastImport: ImportOutcome | null;
  onImportPress: () => void;
  onSelect: (journey: StoredJourney) => void;
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

export default function JourneysScreen({ journeys, assessments, claims, lastImport, onImportPress, onSelect }: Props) {
  const sections = groupByDay(journeys);
  const eligibleCount = journeys.filter(j => assessments.get(j.id)?.status === 'eligible').length;
  const totals = claimTotals([...claims.values()]);

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

      <Pressable style={styles.importButton} onPress={onImportPress}>
        <Text style={styles.importButtonText}>Import journey statement (CSV)</Text>
      </Pressable>
      <Text style={styles.importHint}>Or share a TfL CSV statement to this app from Files / Mail.</Text>
      {lastImport && (
        <Text style={styles.importSummary}>
          {lastImport.fileName}: {lastImport.inserted} new
          {lastImport.upgraded > 0 ? `, ${lastImport.upgraded} fixed` : ''}
          {lastImport.duplicates > 0 ? `, ${lastImport.duplicates} duplicates skipped` : ''}
          {lastImport.incomplete > 0 ? `, ${lastImport.incomplete} incomplete` : ''}
          {lastImport.parsed.skipped > 0 ? ` (${lastImport.parsed.skipped} non-rail rows ignored)` : ''}
        </Text>
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
  importButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
  },
  importButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  importHint: { color: colors.textDim, fontSize: 12, marginTop: spacing.xs },
  importSummary: { color: colors.text, fontSize: 13, marginTop: spacing.s },
  list: { flex: 1, marginTop: spacing.m },
  empty: { color: colors.textDim, fontSize: 14, marginTop: spacing.m },
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
