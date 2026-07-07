// NR-1: Rail journeys list screen.
// Shows all manually-entered rail journeys with DR15 eligibility badges,
// claim status, and a button to add a new journey.
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { bandFor, bandLabel, assessRailJourney } from '../rail/eligibility';
import type { RailJourney } from '../rail/store-core';
import { formatDay, formatGBP } from '../format';
import { colors, spacing } from '../theme';

interface Props {
  journeys: RailJourney[];
  onAdd: () => void;
  onSelect: (journey: RailJourney) => void;
}

const OPERATOR_LABEL: Record<string, string> = {
  avanti: 'Avanti',
  southern: 'Southern',
  gtr: 'GTR',
};

function EligibilityBadge({ journey }: { journey: RailJourney }) {
  if (journey.claimedAt) {
    return <Text style={styles.badgeClaimed}>✓ claimed</Text>;
  }
  if (journey.delayMinutes == null) {
    return <Text style={styles.badgePending}>no delay data</Text>;
  }
  const result = assessRailJourney({ delayMinutes: journey.delayMinutes, singleFare: journey.singleFare });
  if (result.band === 'none') {
    return <Text style={styles.badgeNone}>{journey.delayMinutes} min — not eligible</Text>;
  }
  return (
    <View style={styles.badgeEligible}>
      <Text style={styles.badgeEligibleText}>
        {journey.delayMinutes} min — {bandLabel(result.band)}
        {result.refundAmount != null ? ` ≈ ${formatGBP(result.refundAmount)}` : ''}
      </Text>
    </View>
  );
}

function JourneyRow({ journey, onPress }: { journey: RailJourney; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowTop}>
        <Text style={styles.route}>{journey.originCrs} → {journey.destinationCrs}</Text>
        <Text style={styles.operator}>{OPERATOR_LABEL[journey.operator] ?? journey.operator}</Text>
      </View>
      <Text style={styles.when}>
        {formatDay(journey.departureDate)} · {journey.scheduledDepart}
        {journey.actualDepart ? ` (dep ${journey.actualDepart})` : ''}
        {journey.scheduledArrive ? ` → ${journey.scheduledArrive}` : ''}
        {journey.actualArrive ? ` (arr ${journey.actualArrive})` : ''}
      </Text>
      <EligibilityBadge journey={journey} />
    </Pressable>
  );
}

export default function RailJourneysScreen({ journeys, onAdd, onSelect }: Props) {
  const eligibleCount = journeys.filter(j =>
    j.delayMinutes != null && bandFor(j.delayMinutes) !== 'none' && !j.claimedAt
  ).length;
  const claimedCount = journeys.filter(j => j.claimedAt != null).length;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rail Delay Repay</Text>
      <Text style={styles.subtitle}>
        {journeys.length} journey{journeys.length !== 1 ? 's' : ''}
        {eligibleCount > 0 ? ` · ${eligibleCount} eligible` : ''}
        {claimedCount > 0 ? ` · ${claimedCount} claimed` : ''}
      </Text>

      <Pressable style={styles.addButton} onPress={onAdd}>
        <Text style={styles.addButtonText}>+ Add journey</Text>
      </Pressable>

      {journeys.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No rail journeys yet.</Text>
          <Text style={styles.emptyHint}>Tap "Add journey" to log a delayed train trip.</Text>
          <Text style={styles.emptyHint}>
            Supports Avanti West Coast, Southern Railway, and Thameslink/Great Northern (GTR).
            Eligibility is DR15: delays of 15 min+ qualify for compensation.
          </Text>
        </View>
      ) : (
        <FlatList
          data={journeys}
          keyExtractor={j => String(j.id)}
          renderItem={({ item }) => (
            <JourneyRow journey={item} onPress={() => onSelect(item)} />
          )}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: spacing.m },
  addButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 10,
    padding: spacing.m,
    alignItems: 'center',
    marginBottom: spacing.m,
  },
  addButtonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  list: { flex: 1 },
  row: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    padding: spacing.m,
    marginBottom: spacing.s,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  route: { color: colors.text, fontSize: 16, fontWeight: '700' },
  operator: { color: colors.textDim, fontSize: 12 },
  when: { color: colors.textDim, fontSize: 12, marginBottom: spacing.xs },
  badgeClaimed: { color: colors.good, fontSize: 13, fontWeight: '700' },
  badgePending: { color: colors.textDim, fontSize: 12 },
  badgeNone: { color: colors.textDim, fontSize: 12 },
  badgeEligible: {},
  badgeEligibleText: { color: colors.warn, fontSize: 13, fontWeight: '700' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.l },
  emptyText: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: spacing.s },
  emptyHint: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginBottom: spacing.s },
});
