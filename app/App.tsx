import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import StationSearch from './src/components/StationSearch';
import { estimateFare, Station, stations } from './src/data';
import { colors, spacing } from './src/theme';

// TfL-2 scaffold screen: station search + zone-fare lookup. Replaced by the
// journeys/eligibility UI in TfL-5.
export default function App() {
  const [from, setFrom] = useState<Station | null>(null);
  const [to, setTo] = useState<Station | null>(null);
  const fare = from && to ? estimateFare(from.id, to.id) : null;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <Text style={styles.title}>TfL Delay Repay</Text>
        <Text style={styles.subtitle}>{stations.length} stations bundled</Text>

        <View style={styles.field}>
          <Text style={styles.label}>From</Text>
          <StationSearch placeholder="e.g. Victoria" value={from} onSelect={setFrom} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>To</Text>
          <StationSearch placeholder="e.g. King's Cross" value={to} onSelect={setTo} />
        </View>

        {from && to && (
          <View style={styles.fareCard}>
            <Text style={styles.fareTitle}>Estimated PAYG single</Text>
            {fare ? (
              <View style={styles.fareRow}>
                <Text style={styles.fareValue}>Peak £{fare.peak?.toFixed(2)}</Text>
                <Text style={styles.fareValue}>Off-peak £{fare.offPeak?.toFixed(2)}</Text>
              </View>
            ) : (
              <Text style={styles.fareMissing}>
                Outside the zone matrix — the imported CSV statement's actual charge will be used.
              </Text>
            )}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.l },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.xs },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: spacing.l },
  field: { marginBottom: spacing.m },
  label: { color: colors.textDim, fontSize: 13, fontWeight: '600', marginBottom: spacing.xs, textTransform: 'uppercase' },
  fareCard: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: spacing.m,
    padding: spacing.m,
  },
  fareTitle: { color: colors.textDim, fontSize: 13, fontWeight: '600', marginBottom: spacing.s },
  fareRow: { flexDirection: 'row', justifyContent: 'space-between' },
  fareValue: { color: colors.text, fontSize: 20, fontWeight: '700' },
  fareMissing: { color: colors.textDim, fontSize: 14 },
});
