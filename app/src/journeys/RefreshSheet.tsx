// TfL-11: the journey refresh, visible. A pageSheet modal shows the real TfL
// pages while the TfL-10 harvest script works, with a status bar narrating
// each phase and a Cancel that's safe mid-flow (the import itself is a single
// transaction, so cancelling never leaves half a statement behind).
//
// TfL-13: login and robot-check pages belong entirely to the user — while the
// flow is paused NOTHING is injected and nothing steers (injection is keyed
// off the 'harvesting' phase and steering off 'steering'; paused states
// transition to neither). A Continue button hands control back when they're
// done, and doubles as an escape hatch from any stalled page. A persisted
// Contactless / Oyster / Both choice decides which journey-history section(s)
// the flow visits.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  appendCsvHit,
  buildHarvestScript,
  buildNetProbeScript,
  CSV_LOG_KEY,
  isCsvEndpoint,
  pickCardId,
  rowsToCsv,
} from './autofetch';
import { buildDirectCsvScript, currentAndPreviousPeriods, isNewStatementsUrl } from './direct-csv';
import { getMeta, listCards, setMeta } from './db';
import { importCsvText, ImportOutcome } from './import';
import {
  canHandover,
  FETCH_MODE_KEY,
  FetchMode,
  FlowEvent,
  FlowState,
  isPaused,
  isTerminal,
  makeInitialFlow,
  reduceFlow,
  startUrlFor,
  statusText,
} from './refresh-flow';
import { colors, spacing } from '../theme';

export type RefreshResult =
  | { kind: 'imported'; outcome: ImportOutcome }
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

interface Props {
  onClose: (r: RefreshResult) => void;
}

const DISMISS_DELAY_MS = 1200; // long enough to read the success line

const MODES: { value: FetchMode; label: string }[] = [
  { value: 'contactless', label: 'Contactless' },
  { value: 'oyster', label: 'Oyster' },
  { value: 'both', label: 'Both' },
];

function persistedMode(): FetchMode | null {
  const m = getMeta(FETCH_MODE_KEY);
  return m === 'contactless' || m === 'oyster' || m === 'both' ? m : null;
}

export default function RefreshSheet({ onClose }: Props) {
  const webRef = useRef<WebView>(null);
  const urlRef = useRef(''); // last URL the WebView reported — picks the injected script
  const stateRef = useRef<FlowState>(makeInitialFlow('contactless'));
  const outcomeRef = useRef<ImportOutcome | null>(null);
  const closedRef = useRef(false);
  // null = never chosen: the sheet opens with the chooser and no WebView.
  const [mode, setMode] = useState<FetchMode | null>(persistedMode);
  // DEBUG TfL-15: last 3 URLs seen — strip before next PR
  const [urlLog, setUrlLog] = useState<string[]>([]);
  const addUrlLog = (url: string) => setUrlLog(prev => [...prev.slice(-2), url]);
  const [state, setState] = useState<FlowState>(() => {
    const m = persistedMode();
    const initial = makeInitialFlow(m ?? 'contactless');
    stateRef.current = initial;
    return initial;
  });

  const close = useCallback((r: RefreshResult) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(r);
  }, [onClose]);

  // Capture-only CSV endpoint discovery (TfL-13): log to the db meta table;
  // never disturb the flow, whatever goes wrong.
  const recordCsvHit = (source: string, url: string) => {
    try {
      setMeta(CSV_LOG_KEY, appendCsvHit(getMeta(CSV_LOG_KEY), { source, url, at: new Date().toISOString() }));
    } catch { /* capture only */ }
  };

  // The probe goes in first so either script's own CSV fetches are captured.
  // Only ever called for the 'harvesting' phase — never on a paused page.
  // On the statements page the direct CSV fetch runs (TfL-14); everywhere
  // else the classic harvest does. Periods come from the device's local date
  // so a UTC month boundary can't shift which statements get fetched.
  const injectHarvest = () => {
    const now = new Date();
    const script = isNewStatementsUrl(urlRef.current)
      ? buildDirectCsvScript(currentAndPreviousPeriods(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`))
      : buildHarvestScript();
    webRef.current?.injectJavaScript(buildNetProbeScript() + '\n' + script);
  };

  const dispatch = useCallback((e: FlowEvent) => {
    const next = reduceFlow(stateRef.current, e);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    if (next.phase === 'steering') {
      // Wrong landing page (dashboard, card list…) or the next queued page:
      // the machine says where to go, the WebView follows.
      webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(next.target)}; true;`);
    }
    if (next.phase === 'cancelled') close({ kind: 'cancelled' });
    if (next.phase === 'done') {
      const outcome = outcomeRef.current;
      setTimeout(() => close(outcome ? { kind: 'imported', outcome } : { kind: 'empty' }), DISMISS_DELAY_MS);
    }
    // 'error' stays open — the status bar shows what went wrong and the page
    // stays visible; the button becomes Close.
  }, [close]);

  useEffect(() => () => {
    // Unmounted from outside (e.g. parent state reset) — count it as cancel.
    if (!closedRef.current && !isTerminal(stateRef.current)) close({ kind: 'cancelled' });
  }, [close]);

  const chooseMode = (m: FetchMode) => {
    setMeta(FETCH_MODE_KEY, m);
    // Fresh start: new mode, new flow, new tallies. The WebView remounts via
    // key={mode} and loads the mode's first history page.
    outcomeRef.current = null;
    urlRef.current = '';
    stateRef.current = makeInitialFlow(m);
    setState(stateRef.current);
    setMode(m);
  };

  // Continue button (TfL-13): resume from login/challenge, or force a harvest
  // of whatever page the user navigated to themselves.
  const onContinue = () => {
    dispatch({ type: 'handover' });
    if (stateRef.current.phase === 'harvesting') injectHarvest();
  };

  const onLoaded = (url: string) => {
    urlRef.current = url;
    addUrlLog(url);
    dispatch({ type: 'loaded', url });
    // Injection is keyed off the phase the machine settles in: paused states
    // never reach 'harvesting' on a load, so login/challenge pages get no
    // script at all (TfL-13).
    if (stateRef.current.phase === 'harvesting') injectHarvest();
  };

  // Several cards can each contribute an import (TfL-12) — merge the tallies
  // so the closing summary covers the whole refresh.
  const mergeOutcome = (a: ImportOutcome | null, b: ImportOutcome): ImportOutcome => (a ? {
    ...b,
    inserted: a.inserted + b.inserted,
    upgraded: a.upgraded + b.upgraded,
    duplicates: a.duplicates + b.duplicates,
    incomplete: a.incomplete + b.incomplete,
    parsed: { ...b.parsed, skipped: a.parsed.skipped + b.parsed.skipped },
  } : b);

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'net-probe') {
        recordCsvHit(String(msg.kind ?? 'net'), String(msg.url ?? ''));
        return;
      }
      if (msg.type === 'direct-csv') {
        // TfL-14: the statements-page script. Success feeds the fetched
        // statements straight into the same import path a harvested CSV
        // takes; login/challenge park the flow exactly like harvest reports;
        // everything else falls back to the classic steering harvest.
        if (msg.status === 'csv') {
          const wasHarvesting = stateRef.current.phase === 'harvesting';
          dispatch({ type: 'harvest', status: 'csv' });
          if (!wasHarvesting) return; // duplicate report — import already ran
          try {
            const files = Array.isArray(msg.files) ? msg.files : [];
            const cardId = pickCardId(listCards());
            let inserted = 0;
            for (const f of files) {
              recordCsvHit('direct', String(f?.url ?? ''));
              const outcome = importCsvText(String(f?.text ?? ''), `${cardId}.csv`);
              outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
              inserted += outcome.inserted;
            }
            dispatch({ type: 'imported', inserted });
          } catch (e) {
            dispatch({ type: 'import-failed', message: String(e) });
          }
        } else if (msg.status === 'signed-out' || msg.status === 'challenge') {
          dispatch({ type: 'harvest', status: msg.status });
        } else {
          dispatch({ type: 'direct-failed' }); // wrong-page / failed → steering harvest
        }
        return;
      }
      if (msg.type !== 'journey-harvest') return;
      const cards = Array.isArray(msg.cards) ? msg.cards : undefined;
      if (msg.status === 'csv' || msg.status === 'rows') {
        if (msg.status === 'csv' && msg.url) recordCsvHit('harvest', String(msg.url));
        const wasHarvesting = stateRef.current.phase === 'harvesting';
        dispatch({ type: 'harvest', status: msg.status, cards });
        if (!wasHarvesting) return; // duplicate report — this page's import already ran
        try {
          const csv = msg.status === 'csv' ? String(msg.text ?? '') : rowsToCsv(msg.rows ?? []);
          // Filename → card id: reuse the id previous imports stored so the
          // dedupe index treats auto-fetched rows as the same statement.
          const outcome = importCsvText(csv, `${pickCardId(listCards())}.csv`);
          outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
          dispatch({ type: 'imported', inserted: outcome.inserted });
        } catch (e) {
          dispatch({ type: 'import-failed', message: String(e) });
        }
        return;
      }
      dispatch({ type: 'harvest', status: msg.status, message: msg.message ? String(msg.message) : undefined, cards });
    } catch { /* not ours */ }
  };

  const finished = isTerminal(state);
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={() => dispatch({ type: 'cancel' })}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Text style={styles.title}>Refresh from TfL</Text>
          <Pressable
            style={styles.cancelButton}
            hitSlop={8}
            onPress={() => (state.phase === 'error'
              ? close({ kind: 'error', message: state.message })
              : dispatch({ type: 'cancel' }))}
          >
            <Text style={styles.cancelText}>{finished ? 'Close' : 'Cancel'}</Text>
          </Pressable>
        </View>
        <View style={styles.modeRow}>
          {MODES.map(m => (
            <Pressable
              key={m.value}
              style={[styles.modeChip, mode === m.value && styles.modeChipActive]}
              onPress={() => mode !== m.value && chooseMode(m.value)}
            >
              <Text style={[styles.modeChipText, mode === m.value && styles.modeChipTextActive]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        {mode == null ? (
          <View style={styles.chooser}>
            <Text style={styles.chooserTitle}>How do you travel?</Text>
            <Text style={styles.chooserBody}>
              Pick where your journeys live so the refresh opens the right
              history — contactless bank cards, an Oyster card, or both. You
              can change this any time above.
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.statusBar, state.phase === 'error' && styles.statusBarError]}>
              <Text style={styles.statusText}>{statusText(state)}</Text>
              {canHandover(state) && (
                <Pressable
                  style={[styles.continueButton, isPaused(state) && styles.continueButtonPaused]}
                  hitSlop={8}
                  onPress={onContinue}
                >
                  <Text style={styles.continueText}>Continue</Text>
                </Pressable>
              )}
            </View>
            {/* DEBUG TfL-15: URL breadcrumb — strip before next PR */}
            {urlLog.length > 0 && (
              <View style={styles.urlLog}>
                {urlLog.map((u, i) => (
                  <Text key={i} style={styles.urlLogText} numberOfLines={1}>{u}</Text>
                ))}
              </View>
            )}
            <WebView
              key={mode}
              ref={webRef}
              source={{ uri: startUrlFor(mode) }}
              style={styles.web}
              // Session reuse, not session capture: the cookie stays in the shared
              // system WebView store — the app never reads or persists credentials.
              sharedCookiesEnabled={true}
              incognito={false}
              onLoadEnd={(e: any) => onLoaded(String(e?.nativeEvent?.url ?? ''))}
              onNavigationStateChange={(nav: { url?: string; title?: string }) => {
                if (nav?.url) { urlRef.current = String(nav.url); addUrlLog(String(nav.url)); }
                dispatch({
                  type: 'nav',
                  url: String(nav?.url ?? ''),
                  title: typeof nav?.title === 'string' ? nav.title : undefined,
                });
              }}
              onShouldStartLoadWithRequest={(req: any) => {
                const url = String(req?.url ?? '');
                if (isCsvEndpoint(url)) recordCsvHit('nav', url);
                return true; // observation only — every request proceeds
              }}
              onError={() => dispatch({ type: 'web-error', message: 'page failed to load' })}
              onMessage={onMessage}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.l,
    paddingVertical: spacing.m,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  cancelButton: { paddingVertical: 4, paddingLeft: spacing.m },
  cancelText: { color: colors.accentBright, fontSize: 16, fontWeight: '600' },
  modeRow: {
    flexDirection: 'row',
    gap: spacing.s,
    paddingHorizontal: spacing.l,
    paddingBottom: spacing.s,
  },
  modeChip: {
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: spacing.m,
    paddingVertical: 4,
  },
  modeChipActive: { backgroundColor: colors.card, borderColor: colors.accentBright },
  modeChipText: { color: colors.textDim, fontSize: 13 },
  modeChipTextActive: { color: colors.text, fontWeight: '600' },
  chooser: { flex: 1, paddingHorizontal: spacing.l, paddingTop: spacing.l },
  chooserTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: spacing.s },
  chooserBody: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: spacing.l,
    marginBottom: spacing.s,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  statusBarError: { borderColor: colors.bad },
  statusText: { color: colors.text, fontSize: 13, flex: 1 },
  continueButton: {
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
    marginLeft: spacing.s,
  },
  continueButtonPaused: { borderColor: colors.accentBright },
  continueText: { color: colors.accentBright, fontSize: 14, fontWeight: '700' },
  web: { flex: 1, backgroundColor: '#fff' },
  // DEBUG TfL-15 — strip with the breadcrumb before next PR
  urlLog: { paddingHorizontal: spacing.l, paddingBottom: spacing.s, gap: 2 },
  urlLogText: { color: colors.textDim, fontSize: 10, fontFamily: 'monospace' },
});
