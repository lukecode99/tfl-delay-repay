import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClaimRecord, listClaims } from './src/claims/db';
import { syncClaimReminders } from './src/claims/notify';
import { planReminders } from './src/claims/reminders';
import { claimDeadline } from './src/eligibility/deadline';
import { useAssessments } from './src/eligibility/use-assessments';
import { LAST_AUTOFETCH_KEY, shouldAutoFetch } from './src/journeys/autofetch';
import RefreshSheet, { RefreshResult } from './src/journeys/RefreshSheet';
import { getMeta, listJourneys, setMeta, StoredJourney } from './src/journeys/db';
import { ImportOutcome, importFromUrl, importViaPicker } from './src/journeys/import';
import ClaimDetailScreen from './src/screens/ClaimDetailScreen';
import ClaimWebScreen from './src/screens/ClaimWebScreen';
import HomeScreen from './src/screens/HomeScreen';
import JourneysScreen from './src/screens/JourneysScreen';
import type { JourneyFilter } from './src/journeys/status-tags';
import { getAllRailJourneys, type RailJourney } from './src/rail/db';
import RailJourneysScreen from './src/screens/RailJourneysScreen';
import RailJourneyEntryScreen from './src/screens/RailJourneyEntryScreen';
import RailClaimWebScreen from './src/screens/RailClaimWebScreen';
import AboutScreen from './src/screens/AboutScreen';
import AuditLogScreen from './src/screens/AuditLogScreen';
import StatsScreen from './src/screens/StatsScreen';
import { colors, spacing } from './src/theme';
import { FEATURE_RAIL } from './src/config';

// Home → journeys list → claim detail → guided claim WebView (TfL-5/6).
// State-switched screens — the app is shallow enough that a navigation
// library would be dead weight.
// Home v1.2: summary stats deep-link into Journeys with a filter pre-applied.
// NR-1: Rail mode adds a parallel three-screen stack toggled by a tab bar.
// TfL-18: Log tab shows the refresh audit trail (shareable as text).
// TfL-24: Stats tab — spend charts + poor-service / claimed totals.
// About tab: TfL-terms FAQ + not-affiliated / data-on-device statements.
type AppMode = 'home' | 'journeys' | 'rail' | 'stats' | 'log' | 'about';

export default function App() {
  const [mode, setMode] = useState<AppMode>('home');
  const [journeysFilter, setJourneysFilter] = useState<JourneyFilter>('eligible');
  const openJourneys = useCallback((f: JourneyFilter) => {
    setJourneysFilter(f);
    setMode('journeys');
  }, []);

  // --- TfL state ---
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

  // TfL-10/11: fetch journey history through the signed-in TfL session on
  // app open / foreground / manual refresh — now inside a visible sheet the
  // user can watch (and sign in on, if the session has expired).
  const [autoFetching, setAutoFetching] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const startAutoFetch = useCallback((manual: boolean) => {
    setAutoFetching(current => {
      if (current) return current; // one in flight already
      // TfL-18: only the hidden auto-check is rate-limited — a deliberate tap
      // on Refresh always runs.
      if (!manual && !shouldAutoFetch(getMeta(LAST_AUTOFETCH_KEY), new Date().toISOString())) {
        return current;
      }
      setRefreshNote('Checking TfL for new journeys…');
      return true;
    });
  }, []);

  useEffect(() => { startAutoFetch(false); }, [startAutoFetch]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') startAutoFetch(false); });
    return () => sub.remove();
  }, [startAutoFetch]);

  const onRefreshClose = useCallback((r: RefreshResult) => {
    setAutoFetching(false);
    if (r.kind === 'imported' || r.kind === 'empty') {
      // Only a completed fetch stamps the rate limit — a cancelled or failed
      // attempt leaves Refresh usable straight away.
      setMeta(LAST_AUTOFETCH_KEY, new Date().toISOString());
      if (r.kind === 'imported') {
        setLastImport(r.outcome);
        refresh();
        setRefreshNote(r.outcome.inserted > 0
          ? `Imported ${r.outcome.inserted} new journey${r.outcome.inserted === 1 ? '' : 's'} from TfL.`
          : 'Journeys are up to date.');
      } else {
        setRefreshNote('No journey history on TfL yet.');
      }
    } else if (r.kind === 'cancelled') {
      setRefreshNote(null);
    } else {
      setRefreshNote("Couldn't refresh from TfL — you can still import a CSV.");
    }
  }, [refresh]);

  // --- Rail state ---
  const [railJourneys, setRailJourneys] = useState<RailJourney[]>([]);
  const [railAdding, setRailAdding] = useState(false);
  const [railSelected, setRailSelected] = useState<RailJourney | null>(null);

  const refreshRail = useCallback(() => {
    setRailJourneys(getAllRailJourneys(200));
  }, []);
  useEffect(() => { if (mode === 'rail') refreshRail(); }, [mode, refreshRail]);

  // Tab bar — shown when not deep in a sub-screen
  const showTabs = !selected && !filing && !railAdding && !railSelected;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />

        {/* TfL screens — claim detail/web render above BOTH home and journeys,
            so home's Claim button opens the same flow as a journeys-row tap. */}
        {(mode === 'home' || mode === 'journeys') && (
          selected && filing ? (
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
          ) : mode === 'home' ? (
            <HomeScreen
              journeys={journeys}
              assessments={assessments}
              claims={claims}
              lastImport={lastImport}
              refreshing={autoFetching}
              refreshNote={refreshNote}
              onRefreshPress={() => startAutoFetch(true)}
              onImportPress={onImportPress}
              onSelect={setSelected}
              onOpenJourneys={openJourneys}
            />
          ) : (
            <JourneysScreen
              journeys={journeys}
              assessments={assessments}
              claims={claims}
              lastImport={lastImport}
              onImportPress={onImportPress}
              onSelect={setSelected}
              onRefreshPress={() => startAutoFetch(true)}
              refreshing={autoFetching}
              refreshNote={refreshNote}
              filter={journeysFilter}
              onFilterChange={setJourneysFilter}
            />
          )
        )}
        {(mode === 'home' || mode === 'journeys') && autoFetching && <RefreshSheet onClose={onRefreshClose} />}

        {/* Stats (TfL-24) */}
        {mode === 'stats' && <StatsScreen journeys={journeys} assessments={assessments} claims={claims} />}

        {/* Audit log (TfL-18) */}
        {mode === 'log' && <AuditLogScreen />}

        {/* About & FAQ */}
        {mode === 'about' && <AboutScreen />}

        {/* Rail screens — hidden when FEATURE_RAIL is false */}
        {FEATURE_RAIL && mode === 'rail' && (
          railSelected ? (
            <RailClaimWebScreen
              journey={railSelected}
              onDone={() => { setRailSelected(null); refreshRail(); }}
            />
          ) : railAdding ? (
            <RailJourneyEntryScreen
              onBack={() => setRailAdding(false)}
              onSaved={() => { setRailAdding(false); refreshRail(); }}
            />
          ) : (
            <RailJourneysScreen
              journeys={railJourneys}
              onAdd={() => setRailAdding(true)}
              onSelect={j => {
                if (j.delayMinutes != null && j.delayMinutes >= 15) setRailSelected(j);
              }}
            />
          )
        )}

        {/* Mode toggle tab bar */}
        {showTabs && (
          <View style={styles.tabBar}>
            <Pressable
              style={[styles.tab, mode === 'home' && styles.tabActive]}
              onPress={() => setMode('home')}
            >
              <Text style={[styles.tabText, mode === 'home' && styles.tabTextActive]}>Home</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, mode === 'journeys' && styles.tabActive]}
              onPress={() => setMode('journeys')}
            >
              <Text style={[styles.tabText, mode === 'journeys' && styles.tabTextActive]}>Journeys</Text>
            </Pressable>
            {FEATURE_RAIL && (
              <Pressable
                style={[styles.tab, mode === 'rail' && styles.tabActive]}
                onPress={() => { setMode('rail'); refreshRail(); }}
              >
                <Text style={[styles.tabText, mode === 'rail' && styles.tabTextActive]}>Rail</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.tab, mode === 'stats' && styles.tabActive]}
              onPress={() => setMode('stats')}
            >
              <Text style={[styles.tabText, mode === 'stats' && styles.tabTextActive]}>Stats</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, mode === 'log' && styles.tabActive]}
              onPress={() => setMode('log')}
            >
              <Text style={[styles.tabText, mode === 'log' && styles.tabTextActive]}>Log</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, mode === 'about' && styles.tabActive]}
              onPress={() => setMode('about')}
            >
              <Text style={[styles.tabText, mode === 'about' && styles.tabTextActive]}>About</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.l },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: spacing.s,
    marginTop: spacing.s,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.s,
    borderRadius: 8,
  },
  tabActive: { backgroundColor: colors.card },
  tabText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: colors.accentBright, fontWeight: '800' },
});
