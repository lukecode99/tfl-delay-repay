import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { listClaims } from './src/claims/db';
import { useAssessments } from './src/eligibility/use-assessments';
import { listJourneys, StoredJourney } from './src/journeys/db';
import { ImportOutcome, importFromUrl, importViaPicker } from './src/journeys/import';
import ClaimDetailScreen from './src/screens/ClaimDetailScreen';
import ClaimWebScreen from './src/screens/ClaimWebScreen';
import JourneysScreen from './src/screens/JourneysScreen';
import { colors, spacing } from './src/theme';

// Journeys list → claim detail → guided claim WebView (TfL-5/6). Three
// screens, state-switched — the app is shallow enough that a navigation
// library would be dead weight.
export default function App() {
  const [journeys, setJourneys] = useState<StoredJourney[]>([]);
  const [selected, setSelected] = useState<StoredJourney | null>(null);
  const [filing, setFiling] = useState(false);
  const [claimedIds, setClaimedIds] = useState<Set<number>>(new Set());
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const assessments = useAssessments(journeys);

  const refresh = useCallback(() => {
    setJourneys(listJourneys(200));
    setClaimedIds(new Set(listClaims().map(c => c.journeyId)));
  }, []);
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
        {selected && filing ? (
          <ClaimWebScreen
            journey={selected}
            assessment={assessments.get(selected.id)}
            onDone={() => { setFiling(false); refresh(); }}
          />
        ) : selected ? (
          <ClaimDetailScreen
            journey={selected}
            assessment={assessments.get(selected.id)}
            onBack={() => { setSelected(null); refresh(); }}
            onFileClaim={() => setFiling(true)}
          />
        ) : (
          <JourneysScreen
            journeys={journeys}
            assessments={assessments}
            claimedIds={claimedIds}
            lastImport={lastImport}
            onImportPress={onImportPress}
            onSelect={setSelected}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.l },
});
