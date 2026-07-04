import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClaimRecord, listClaims } from './src/claims/db';
import { syncClaimReminders } from './src/claims/notify';
import { planReminders } from './src/claims/reminders';
import { claimDeadline } from './src/eligibility/deadline';
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
  const [claims, setClaims] = useState<Map<number, ClaimRecord>>(new Map());
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const assessments = useAssessments(journeys);

  const refresh = useCallback(() => {
    setJourneys(listJourneys(200));
    setClaims(new Map(listClaims().map(c => [c.journeyId, c])));
  }, []);
  useEffect(refresh, [refresh]);

  // Claim-deadline reminders (TfL-7): T−5 and T−1 local notifications for
  // eligible unclaimed journeys. Debounced — assessments trickle in one
  // journey at a time, and each sync reconciles the whole schedule anyway.
  useEffect(() => {
    const t = setTimeout(() => {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const plan = planReminders(journeys.map(j => ({
        journeyId: j.id,
        date: j.date,
        origin: j.origin,
        destination: j.destination,
        eligible: assessments.get(j.id)?.status === 'eligible',
        claimed: claims.has(j.id),
        refundValue: assessments.get(j.id)?.refundValue ?? null,
        ...claimDeadline(j.date, todayStr),
      })), todayStr);
      syncClaimReminders(plan).catch(() => { /* notifications are best-effort */ });
    }, 2000);
    return () => clearTimeout(t);
  }, [journeys, assessments, claims]);

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
            claims={claims}
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
