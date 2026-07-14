// Stats tab (TfL-24). A read-only dashboard over data the app already holds:
//   • Poor-service cost — total delay-repay refund the eligibility engine has
//     found since the earliest journey, and how much of it you've reclaimed.
//   • Claimed via the app — lifetime filed / paid / open totals.
//   • Monthly transport spend — hand-rolled horizontal bar chart.
//   • Transport split — a segmented bar + legend (bus / tube / rail / river).
//
// Spend + split come from the combined raw-statements export (buses included,
// unlike the rail-only journeys table); the two claim cards come from the
// eligibility assessments + claim ledger already in App state. Charts are plain
// RN Views — no react-native-svg (avoids the React-19 defaultProps native
// crash chart libs bring) and no literal pie (a segmented bar reads clearer on
// a phone and needs no canvas).
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StoredJourney } from '../journeys/db';
import type { ClaimRecord } from '../claims/db';
import type { AssessmentMap } from '../eligibility/use-assessments';
import { claimTotals } from '../claims/stats';
import { readRawStatements } from '../journeys/raw-export-io';
import { computeStats, MODE_LABEL, type TransportMode, type TransportStats } from '../journeys/stats';
import { colors, spacing } from '../theme';

const MODE_COLOR: Record<TransportMode, string> = {
  tube: colors.accentBright,
  bus: colors.warn,
  rail: colors.good,
  river: '#3AAFC9',
  other: colors.textDim,
};

const gbp = (n: number) => `£${n.toFixed(2)}`;
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_LABEL[Number(m) - 1] ?? m} ${y.slice(2)}`;
}
function prettyDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTH_LABEL[Number(m) - 1] ?? m} ${y}`;
}

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  claims: Map<number, ClaimRecord>;
}

export default function StatsScreen({ journeys, assessments, claims }: Props) {
  const [spend, setSpend] = useState<TransportStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readRawStatements()
      .then(text => { if (!cancelled) { setSpend(text ? computeStats(text) : null); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // Poor-service cost: total refund value of journeys the engine rated
  // eligible, over the whole history held on device.
  let poorServiceCost = 0;
  let eligibleCount = 0;
  for (const j of journeys) {
    const a = assessments.get(j.id);
    if (a?.status === 'eligible') { poorServiceCost += a.refundValue ?? 0; eligibleCount++; }
  }

  const totals = claimTotals([...claims.values()].map(c => ({
    status: c.status, expectedValue: c.expectedValue, paidAmount: c.paidAmount,
  })));

  const maxMonth = spend ? Math.max(1, ...spend.byMonth.map(m => m.spend)) : 1;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: spacing.l }}>
      <Text style={styles.title}>Stats</Text>

      {/* Poor-service cost */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Poor service cost</Text>
        <Text style={styles.bigNumber}>{gbp(poorServiceCost)}</Text>
        <Text style={styles.cardSub}>
          {eligibleCount === 0
            ? 'No delay-repay-eligible journeys found yet — nothing owed.'
            : `across ${eligibleCount} eligible journey${eligibleCount === 1 ? '' : 's'} since your earliest extract`}
        </Text>
      </View>

      {/* Claimed via the app */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Claimed via the app</Text>
        <Text style={styles.bigNumber}>{gbp(totals.claimedValue)}</Text>
        <Text style={styles.cardSub}>
          {totals.claimedCount} claim{totals.claimedCount === 1 ? '' : 's'} filed
        </Text>
        <View style={styles.pillRow}>
          <View style={styles.pill}><Text style={[styles.pillNum, { color: colors.good }]}>{gbp(totals.paidValue)}</Text><Text style={styles.pillCap}>paid ({totals.paidCount})</Text></View>
          <View style={styles.pill}><Text style={styles.pillNum}>{totals.openCount}</Text><Text style={styles.pillCap}>awaiting</Text></View>
          <View style={styles.pill}><Text style={styles.pillNum}>{totals.rejectedCount}</Text><Text style={styles.pillCap}>rejected</Text></View>
        </View>
      </View>

      {/* Spend cards depend on the raw-statements export being present */}
      {!loaded ? (
        <Text style={styles.hint}>Loading spend…</Text>
      ) : !spend || spend.journeyCount === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Transport spend</Text>
          <Text style={styles.cardSub}>
            No spend data yet. Pull your statements from the TfL tab (Refresh), then come back —
            the charts read from that export so they can include buses.
          </Text>
        </View>
      ) : (
        <>
          {/* Monthly spend bar chart */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Spend per month</Text>
            <Text style={styles.cardSub}>
              {gbp(spend.totalSpend)} total · {prettyDate(spend.earliestDate)} → {prettyDate(spend.latestDate)}
            </Text>
            <View style={styles.chart}>
              {spend.byMonth.map(m => (
                <View key={m.month} style={styles.barRow}>
                  <Text style={styles.barLabel}>{monthName(m.month)}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { flex: Math.max(0.02, m.spend / maxMonth) }]} />
                    <View style={{ flex: Math.max(0.001, 1 - m.spend / maxMonth) }} />
                  </View>
                  <Text style={styles.barValue}>{gbp(m.spend)}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Transport split */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Transport split</Text>
            <View style={styles.splitBar}>
              {spend.byMode.map(m => (
                <View key={m.mode} style={{ flex: Math.max(0.001, m.spend / spend.totalSpend), backgroundColor: MODE_COLOR[m.mode] }} />
              ))}
            </View>
            <View style={styles.legend}>
              {spend.byMode.map(m => {
                const pct = spend.totalSpend > 0 ? Math.round((m.spend / spend.totalSpend) * 100) : 0;
                return (
                  <View key={m.mode} style={styles.legendRow}>
                    <View style={[styles.swatch, { backgroundColor: MODE_COLOR[m.mode] }]} />
                    <Text style={styles.legendLabel}>{MODE_LABEL[m.mode]}</Text>
                    <Text style={styles.legendValue}>{gbp(m.spend)} · {pct}%</Text>
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.m },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  cardLabel: { color: colors.textDim, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  bigNumber: { color: colors.text, fontSize: 34, fontWeight: '800', marginTop: spacing.xs },
  cardSub: { color: colors.textDim, fontSize: 13, marginTop: spacing.xs },
  hint: { color: colors.textDim, fontSize: 14, marginBottom: spacing.m },
  pillRow: { flexDirection: 'row', marginTop: spacing.m },
  pill: { flex: 1, alignItems: 'center' },
  pillNum: { color: colors.text, fontSize: 18, fontWeight: '700' },
  pillCap: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  chart: { marginTop: spacing.m },
  barRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  barLabel: { color: colors.textDim, fontSize: 11, width: 48 },
  barTrack: { flex: 1, flexDirection: 'row', height: 14, borderRadius: 4, backgroundColor: colors.bg, overflow: 'hidden', marginHorizontal: spacing.s },
  barFill: { backgroundColor: colors.accentBright, borderRadius: 4 },
  barValue: { color: colors.text, fontSize: 11, width: 52, textAlign: 'right' },
  splitBar: { flexDirection: 'row', height: 22, borderRadius: 6, overflow: 'hidden', marginTop: spacing.m },
  legend: { marginTop: spacing.m },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  swatch: { width: 12, height: 12, borderRadius: 3, marginRight: spacing.s },
  legendLabel: { color: colors.text, fontSize: 14, flex: 1 },
  legendValue: { color: colors.textDim, fontSize: 13 },
});
