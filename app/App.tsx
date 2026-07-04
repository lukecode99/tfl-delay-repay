import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import StationSearch from './src/components/StationSearch';
import { estimateFare, Station, stations } from './src/data';
import { listJourneys, StoredJourney } from './src/journeys/db';
import { ImportOutcome, importFromUrl, importViaPicker } from './src/journeys/import';
import { colors, spacing } from './src/theme';

// TfL-2 scaffold screen + TfL-3 CSV import. Replaced by the
// journeys/eligibility UI in TfL-5.
export default function App() {
  const [from, setFrom] = useState<Station | null>(null);
  const [to, setTo] = useState<Station | null>(null);
  const [journeys, setJourneys] = useState<StoredJourney[]>([]);
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const fare = from && to ? estimateFare(from.id, to.id) : null;

  const refresh = useCallback(() => setJourneys(listJourneys(50)), []);
  useEffect(refresh, [refresh]);

  const handleOutcome = useCallback((outcome: ImportOutcome | null) => {
    if (!outcome) return;
    setLastImport(outcome);
    refresh();
  }, [refresh]);

  // Share-sheet / "Open in" entry: iOS launches or foregrounds the app with a
  // file:// URL when a CSV is shared to it.
  useEffect(() => {
    const onUrl = (url: string) =>
      importFromUrl(url).then(handleOutcome).catch(e => Alert.alert('Import failed', String(e)));
    Linking.getInitialURL().then(url => { if (url) onUrl(url); });
    const sub = Linking.addEventListener('url', ({ url }) => onUrl(url));
    return () => sub.remove();
  }, [handleOutcome]);

  const onImportPress = useCallback(() => {
    importViaPicker().then(handleOutcome).catch(e => Alert.alert('Import failed', String(e)));
  }, [handleOutcome]);

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

        <Pressable style={styles.importButton} onPress={onImportPress}>
          <Text style={styles.importButtonText}>Import journey statement (CSV)</Text>
        </Pressable>
        <Text style={styles.importHint}>
          Or share a TfL CSV statement to this app from Files / Mail.
        </Text>

        {lastImport && (
          <Text style={styles.importSummary}>
            {lastImport.fileName}: {lastImport.inserted} new
            {lastImport.duplicates > 0 ? `, ${lastImport.duplicates} duplicates skipped` : ''}
            {lastImport.incomplete > 0 ? `, ${lastImport.incomplete} incomplete` : ''}
            {lastImport.parsed.skipped > 0 ? ` (${lastImport.parsed.skipped} non-rail rows ignored)` : ''}
          </Text>
        )}

        <Text style={styles.label}>Journeys ({journeys.length})</Text>
        <FlatList
          data={journeys}
          keyExtractor={j => String(j.id)}
          style={styles.journeyList}
          ListEmptyComponent={<Text style={styles.fareMissing}>No journeys imported yet.</Text>}
          renderItem={({ item }) => (
            <View style={styles.journeyRow}>
              <View style={styles.journeyMain}>
                <Text style={styles.journeyRoute} numberOfLines={1}>
                  {item.origin} → {item.destination ?? '?'}
                </Text>
                <Text style={styles.journeyMeta}>
                  {item.date}  {item.tapInTime ?? '--:--'}–{item.tapOutTime ?? '--:--'}
                  {item.incomplete ? '  ⚠ incomplete' : ''}
                </Text>
              </View>
              <Text style={styles.journeyCharge}>
                {item.charge != null ? `£${item.charge.toFixed(2)}` : ''}
              </Text>
            </View>
          )}
        />
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
  importButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    marginTop: spacing.l,
    padding: spacing.m,
    alignItems: 'center',
  },
  importButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  importHint: { color: colors.textDim, fontSize: 12, marginTop: spacing.xs, marginBottom: spacing.m },
  importSummary: { color: colors.text, fontSize: 13, marginBottom: spacing.m },
  journeyList: { flex: 1, marginTop: spacing.xs },
  journeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomColor: colors.cardBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.s,
  },
  journeyMain: { flex: 1, marginRight: spacing.s },
  journeyRoute: { color: colors.text, fontSize: 15, fontWeight: '600' },
  journeyMeta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  journeyCharge: { color: colors.text, fontSize: 15, fontWeight: '700' },
});
