// Journeys tab (home v1.2 redesign): full journey list with lifecycle filter
// chips. A journey carries a SET of status tags (eligible/claimed/awaiting/
// received/rejected/missed can coexist) and chips match "has this tag".
// The home screen deep-links here with a filter pre-applied.
import React from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import type { ClaimRecord } from '../claims/db';
import { claimDeadline } from '../eligibility/deadline';
import type { Assessment } from '../eligibility/engine';
import type { AssessmentMap } from '../eligibility/use-assessments';
import { formatGBP, groupByDay } from '../format';
import type { StoredJourney } from '../journeys/db';
import type { ImportOutcome } from '../journeys/import';
import type { OverchargeCandidate } from '../journeys/incomplete-fare';
import {
  FILTER_LABELS, FILTER_ORDER, matchesFilter, statusTags,
  type JourneyFilter, type StatusTag,
} from '../journeys/status-tags';
import { colors, spacing } from '../theme';

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  /** Detected max-fare overcharges, keyed by journey id (computed in App). */
  overchargeById: Map<number, OverchargeCandidate>;
  claims: Map<number, ClaimRecord>;
  lastImport: ImportOutcome | null;
  onImportPress: () => void;
  onSelect: (journey: StoredJourney) => void;
  onRefreshPress: () => void;
  refreshing: boolean;
  refreshNote: string | null;
  /** Filter pushed in by a home-screen stat tap. */
  filter: JourneyFilter;
  onFilterChange: (f: JourneyFilter) => void;
}

function Badge({ assessment, claim, missed, overcharge }: {
  assessment: Assessment | undefined;
  claim: ClaimRecord | undefined;
  missed: boolean;
  overcharge: OverchargeCandidate | undefined;
}) {
  if (missed) return <Text style={styles.badgeExpired}>Expired</Text>;
  if (claim?.status === 'paid') {
    return (
      <Text style={styles.badgeClaimed}>
        ✓ paid{claim.paidAmount != null ? ` ${formatGBP(claim.paidAmount)}` : ''}
      </Text>
    );
  }
  if (claim?.status === 'rejected') return <Text style={styles.badgeRejected}>✗ rejected</Text>;
  if (claim) return <Text style={styles.badgeClaimed}>✓ claimed</Text>;
  if (overcharge && overcharge.claimStatus !== 'expired') {
    return <Text style={styles.badgeWarn}>⚠ +{formatGBP(overcharge.estimatedRefund)}</Text>;
  }
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

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function JourneysScreen({
  journeys, assessments, overchargeById, claims, lastImport, onImportPress, onSelect,
  onRefreshPress, refreshing, refreshNote, filter, onFilterChange,
}: Props) {
  const today = React.useMemo(todayISO, []);

  // Tag every journey once per data change; chips and counts both read this.
  // Overcharge detail lives on the journey's own detail screen (TfL-OVERCHARGE-UX)
  // — discovery here is via the Overcharged/Eligible chips and the row badge.
  const tagsById = React.useMemo(() => {
    const m = new Map<number, Set<StatusTag>>();
    for (const j of journeys) {
      const oc = overchargeById.get(j.id);
      m.set(j.id, statusTags({
        eligible: assessments.get(j.id)?.status === 'eligible',
        overcharged: oc != null && oc.claimStatus !== 'expired',
        claimStatus: claims.get(j.id)?.status ?? null,
        daysLeft: claimDeadline(j.date, today).daysLeft,
      }));
    }
    return m;
  }, [journeys, assessments, overchargeById, claims, today]);

  const filteredJourneys = journeys.filter(j => matchesFilter(tagsById.get(j.id) ?? new Set(), filter));
  const sections = groupByDay(filteredJourneys);
  const missedCount = filter === 'missed' ? filteredJourneys.length : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Journeys</Text>

      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.refreshButton, styles.buttonRowItem, refreshing && styles.refreshButtonBusy]}
          onPress={onRefreshPress}
          disabled={refreshing}
        >
          <Text style={styles.refreshButtonText}>{refreshing ? 'Checking TfL…' : 'Refresh from TfL'}</Text>
        </Pressable>
        <Pressable style={[styles.importButton, styles.buttonRowItem]} onPress={onImportPress}>
          <Text style={styles.importButtonText}>Import CSV</Text>
        </Pressable>
      </View>
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

      {/* Lifecycle filter chips — wrap onto two rows */}
      <View style={styles.chipRow}>
        {FILTER_ORDER.map(f => (
          <Pressable
            key={f}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => onFilterChange(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
              {FILTER_LABELS[f]}
            </Text>
          </Pressable>
        ))}
      </View>
      {filter === 'missed' && missedCount > 0 && (
        <Text style={styles.missedCaption}>
          {missedCount} MISSED · OVER 28 DAYS OLD — WINDOW CLOSED
        </Text>
      )}

      <SectionList
        sections={sections}
        keyExtractor={j => String(j.id)}
        style={styles.list}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {filter === 'all' ? 'No journeys imported yet.' : `No ${FILTER_LABELS[filter].toLowerCase()} journeys.`}
          </Text>
        }
        renderSectionHeader={({ section }) => <Text style={styles.dayHeader}>{section.title}</Text>}
        renderItem={({ item }) => {
          const missed = tagsById.get(item.id)?.has('missed') ?? false;
          const a = assessments.get(item.id);
          return (
            <Pressable style={[styles.row, missed && styles.rowMissed]} onPress={() => onSelect(item)}>
              {missed && <View style={styles.stripeMissed} />}
              <View style={styles.rowMain}>
                <Text style={styles.route} numberOfLines={1}>
                  {item.origin} → {item.destination ?? '?'}
                </Text>
                <Text style={styles.meta}>
                  {item.tapInTime ?? '--:--'}–{item.tapOutTime ?? '--:--'}
                  {item.charge != null ? `  ·  ${formatGBP(item.charge)}` : ''}
                  {missed && a?.refundValue != null ? `  ·  was worth ${formatGBP(a.refundValue)}` : ''}
                </Text>
              </View>
              <Badge
                assessment={a}
                claim={claims.get(item.id)}
                missed={missed}
                overcharge={overchargeById.get(item.id)}
              />
              <Text style={styles.chevron}>›</Text>
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
  buttonRow: { flexDirection: 'row' },
  buttonRowItem: { flex: 1 },
  refreshButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
    marginRight: spacing.s,
  },
  refreshButtonBusy: { opacity: 0.6 },
  refreshButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  importButton: {
    backgroundColor: colors.card,
    borderColor: colors.accentBright,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
  },
  importButtonText: { color: colors.accentBright, fontSize: 16, fontWeight: '700' },
  importSummary: { color: colors.text, fontSize: 13, marginTop: spacing.s },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.m },
  chip: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: spacing.s,
    paddingHorizontal: spacing.m - 2,
    marginRight: spacing.s,
    marginBottom: spacing.s,
  },
  chipActive: { backgroundColor: colors.accentBright, borderColor: colors.accentBright },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  missedCaption: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: spacing.xs,
  },
  list: { flex: 1 },
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
  rowMissed: { opacity: 0.65 },
  stripeMissed: { width: 4, alignSelf: 'stretch', borderRadius: 3, backgroundColor: colors.textDim, marginRight: spacing.m },
  rowMain: { flex: 1, marginRight: spacing.s },
  route: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  badgePending: { color: colors.textDim, fontSize: 15, marginRight: spacing.s },
  badgeClaimed: { color: colors.good, fontSize: 13, fontWeight: '700', marginRight: spacing.s },
  badgeRejected: { color: colors.bad, fontSize: 13, fontWeight: '700', marginRight: spacing.s },
  badgeWarn: { color: colors.warn, fontSize: 13, fontWeight: '700', marginRight: spacing.s },
  badgeExpired: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: colors.bg,
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
    overflow: 'hidden',
    marginRight: spacing.s,
  },
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
