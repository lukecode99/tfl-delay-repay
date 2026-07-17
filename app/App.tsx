// Side-effect import: registers the background fetch task at module evaluation
// time (required by expo-task-manager before any component mounts).
import './src/notifications/background-task';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { ClaimRecord, listClaims } from './src/claims/db';
import { initLedger, refreshLedger } from './src/data/ledger-store';
import { checkDisruptions } from './src/disruptions/check';
import PushSlotsScreen from './src/screens/PushSlotsScreen';
import { syncClaimReminders } from './src/claims/notify';
import { planReminders } from './src/claims/reminders';
import { claimDeadline } from './src/eligibility/deadline';
import { useAssessments } from './src/eligibility/use-assessments';
import { LAST_AUTOFETCH_KEY, shouldAutoFetch } from './src/journeys/autofetch';
import RefreshSheet, { RefreshResult } from './src/journeys/RefreshSheet';
import { getMeta, listAllJourneys, listJourneys, setMeta, StoredJourney } from './src/journeys/db';
import { ImportOutcome, importFromUrl, importViaPicker } from './src/journeys/import';
import ClaimDetailScreen from './src/screens/ClaimDetailScreen';
import ClaimWebScreen from './src/screens/ClaimWebScreen';
import HomeScreen from './src/screens/HomeScreen';
import JourneysScreen from './src/screens/JourneysScreen';
import WelcomeScreen from './src/screens/WelcomeScreen';
import type { JourneyFilter } from './src/journeys/status-tags';
import { detectOvercharges, type OverchargeCandidate } from './src/journeys/incomplete-fare';
import { journeyKey } from './src/journeys/parse';
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
// TfL-PUSH: Notifications tab — delay alert subscriptions.
type AppMode = 'home' | 'journeys' | 'rail' | 'stats' | 'log' | 'notifications' | 'about';

// First-launch guide (16-Jul): shows once, then never again. Bump the key to
// re-show after a flow change big enough that existing users need the tour.
const WELCOME_SEEN_KEY = 'welcome-seen-v1';

export default function App() {
  const [mode, setMode] = useState<AppMode>('home');
  const [showWelcome, setShowWelcome] = useState(() => getMeta(WELCOME_SEEN_KEY) == null);
  const [journeysFilter, setJourneysFilter] = useState<JourneyFilter>('eligible');
  const openJourneys = useCallback((f: JourneyFilter) => {
    setJourneysFilter(f);
    setMode('journeys');
  }, []);

  // --- TfL-LIVE: live ledger fetch ---
  const [ledgerNote, setLedgerNote] = useState<string | null>(null);
  useEffect(() => {
    initLedger().then(r => { if (r.dataNote) setLedgerNote(r.dataNote); });
  }, []);

  // --- TfL state ---
  const [journeys, setJourneys] = useState<StoredJourney[]>([]);
  const [selected, setSelected] = useState<StoredJourney | null>(null);
  const [filing, setFiling] = useState(false);
  const pendingNotifJourneyId = useRef<number | null>(null);
  const [claims, setClaims] = useState<Map<number, ClaimRecord>>(new Map());
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const assessments = useAssessments(journeys);

  // TfL-OVERCHARGE-UX: detect max-fare overcharges once, keyed by journey id,
  // so the Journeys chips, Home stats and the claim-detail card all agree.
  const overchargeById = React.useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const byKey = new Map(detectOvercharges(journeys, { asOfISO: today }).map(c => [c.journeyKey, c]));
    const m = new Map<number, OverchargeCandidate>();
    for (const j of journeys) {
      const c = byKey.get(journeyKey(j));
      if (c) m.set(j.id, c);
    }
    return m;
  }, [journeys]);

  // HOME-LAUNCH: tap a claim-deadline notification → deep-link to journey detail
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const journeyId = response.notification.request.content.data?.journeyId as number | undefined;
      if (journeyId == null) return;
      const j = journeys.find(x => x.id === journeyId);
      if (j) { setSelected(j); setMode('journeys'); }
      else { pendingNotifJourneyId.current = journeyId; }
    },
    [journeys],
  );

  // Handle notification tap on cold start
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) handleNotificationResponse(response);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle notification tap while foregrounded
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => sub.remove();
  }, [handleNotificationResponse]);

  const refresh = useCallback(() => {
    setJourneys(listAllJourneys());
    setClaims(new Map(listClaims().map(c => [c.journeyId, c])));
  }, []);
  useEffect(refresh, [refresh]);

  // Resolve a notification tap that arrived before journeys were loaded
  useEffect(() => {
    if (pendingNotifJourneyId.current == null || journeys.length === 0) return;
    const j = journeys.find(x => x.id === pendingNotifJourneyId.current);
    if (j) { setSelected(j); setMode('journeys'); pendingNotifJourneyId.current = null; }
  }, [journeys]);

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

  // Hold the launch auto-fetch while the first-run guide is up — dismissing it
  // flips showWelcome and the fetch (step 1 of the guide) starts right after.
  useEffect(() => { if (!showWelcome) startAutoFetch(false); }, [startAutoFetch, showWelcome]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {
        startAutoFetch(false);
        refreshLedger(); // best-effort — throttled to 30 min
        checkDisruptions().catch(() => {}); // foreground-only disruption check
      }
    });
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
              overcharge={overchargeById.get(selected.id)}
              onBack={() => { setSelected(null); refresh(); }}
              onFileClaim={() => setFiling(true)}
            />
          ) : mode === 'home' ? (
            <HomeScreen
              journeys={journeys}
              assessments={assessments}
              overchargeById={overchargeById}
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
              overchargeById={overchargeById}
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

        {/* TfL-PUSH: delay alert slot subscriptions */}
        {mode === 'notifications' && (
          <PushSlotsScreen
            journeys={journeys}
            assessments={assessments}
            onBack={() => setMode('home')}
          />
        )}

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

        {/* Mode toggle tab bar. numberOfLines + adjustsFontSizeToFit keep every
            label on one line — "Journeys" was wrapping onto two rows. */}
        {showTabs && (
          <View style={styles.tabBar}>
            {([
              ['home', 'Home'],
              ['journeys', 'Journeys'],
              ...(FEATURE_RAIL ? [['rail', 'Rail']] : []),
              ['stats', 'Stats'],
              ['log', 'Log'],
              ['notifications', 'Alerts'],
              ['about', 'About'],
            ] as [AppMode, string][]).map(([m, label]) => (
              <Pressable
                key={m}
                style={[styles.tab, mode === m && styles.tabActive]}
                onPress={() => { setMode(m); if (m === 'rail') refreshRail(); }}
              >
                <Text
                  style={[styles.tabText, mode === m && styles.tabTextActive]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* First-run guide overlays everything until dismissed */}
        {showWelcome && (
          <View style={[StyleSheet.absoluteFill, styles.welcomeOverlay]}>
            <WelcomeScreen
              onDone={() => { setMeta(WELCOME_SEEN_KEY, new Date().toISOString()); setShowWelcome(false); }}
            />
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
  tabText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.accentBright, fontWeight: '800' },
  welcomeOverlay: { backgroundColor: colors.bg, padding: spacing.l },
});
