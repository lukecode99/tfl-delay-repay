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
//
// TfL-18: the statements page is gone, so the direct CSV attempt no longer
// arrives via a page load — advance() flips the flow straight into an
// in-place harvesting state, and dispatch() injects the direct script the
// moment it sees that transition. Every URL, phase change and fetch status is
// also written to the persistent audit log (the app's Log tab), and a Manual
// chip opens a capture-only WebView where the user drives and the app just
// records.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
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
import { appendAudit, AUDIT_LOG_KEY } from './audit-log';
import { buildDirectCsvScript, cardIdsFromLog, currentAndPreviousPeriods, isDirectCsvUrl } from './direct-csv';
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

// Manual capture (TfL-18) starts from the contactless landing page — signed
// in it links everywhere the user might download a statement from.
const CAPTURE_URL = 'https://contactless.tfl.gov.uk/HomePage';

function persistedMode(): FetchMode | null {
  const m = getMeta(FETCH_MODE_KEY);
  return m === 'contactless' || m === 'oyster' || m === 'both' ? m : null;
}

// TfL-18: has this flow state already made its in-place direct CSV attempt?
function directTried(s: FlowState): boolean {
  return 'directTried' in s && s.directTried === true;
}

export default function RefreshSheet({ onClose }: Props) {
  const webRef = useRef<WebView>(null);
  const urlRef = useRef(''); // last URL the WebView reported — picks the injected script
  const stateRef = useRef<FlowState>(makeInitialFlow('contactless'));
  const outcomeRef = useRef<ImportOutcome | null>(null);
  const closedRef = useRef(false);
  // TfL-18: set while a dispatch() call injects the in-place direct script,
  // so the handler that triggered it doesn't inject a second time.
  const dispatchInjected = useRef(false);
  // null = never chosen: the sheet opens with the chooser and no WebView.
  const [mode, setMode] = useState<FetchMode | null>(persistedMode);
  // TfL-18: Manual capture — the user drives, the app only records.
  const [capture, setCapture] = useState(false);
  const [state, setState] = useState<FlowState>(() => {
    const m = persistedMode();
    const initial = makeInitialFlow(m ?? 'contactless');
    stateRef.current = initial;
    return initial;
  });

  // Audit trail (TfL-18): a persistent record of what the refresh actually
  // did, shown in the app's Log tab. Capture only — a logging failure must
  // never be able to break a refresh.
  const recordAudit = (tag: string, detail?: string) => {
    try {
      setMeta(AUDIT_LOG_KEY, appendAudit(getMeta(AUDIT_LOG_KEY), { at: new Date().toISOString(), tag, detail }));
    } catch { /* capture only */ }
  };

  const close = useCallback((r: RefreshResult) => {
    if (closedRef.current) return;
    closedRef.current = true;
    recordAudit('close', r.kind === 'imported' ? `imported ${r.outcome.inserted} new` : r.kind);
    onClose(r);
    // recordAudit is stable in behaviour (no state captured) — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // On the statements page or the contactless Dashboard the direct CSV fetch
  // runs (TfL-14/17), seeded with card ids the endpoint log captured on
  // earlier refreshes (the Dashboard links no statements itself); everywhere
  // else the classic harvest does. Periods come from the device's local date
  // so a UTC month boundary can't shift which statements get fetched.
  const directScript = () => {
    const now = new Date();
    return buildDirectCsvScript(currentAndPreviousPeriods(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`),
      cardIdsFromLog(getMeta(CSV_LOG_KEY)));
  };

  const injectHarvest = () => {
    const direct = isDirectCsvUrl(urlRef.current);
    recordAudit('inject', `${direct ? 'direct-csv' : 'harvest'} on ${urlRef.current}`);
    webRef.current?.injectJavaScript(buildNetProbeScript() + '\n' + (direct ? directScript() : buildHarvestScript()));
  };

  // TfL-18: the in-place direct attempt runs on whatever page is showing —
  // always the direct script, never the URL-keyed harvest picker.
  const injectDirect = () => {
    recordAudit('inject', `direct-csv in place on ${urlRef.current}`);
    webRef.current?.injectJavaScript(buildNetProbeScript() + '\n' + directScript());
  };

  const dispatch = useCallback((e: FlowEvent) => {
    const prev = stateRef.current;
    const next = reduceFlow(prev, e);
    if (next === prev) return;
    stateRef.current = next;
    setState(next);
    if (next.phase !== prev.phase) {
      recordAudit('phase', next.phase + (next.phase === 'steering' ? ` → ${next.target}` : ''));
    }
    // TfL-18: queue exhausted → the direct CSV attempt happens in place, so
    // no page load will ever fire to trigger injection — inject on the
    // transition itself. The ref stops the calling handler doubling up.
    if (next.phase === 'harvesting' && directTried(next) && !directTried(prev)) {
      dispatchInjected.current = true;
      injectDirect();
    }
    if (next.phase === 'steering') {
      // Wrong landing page (dashboard, card list…) or the next queued page:
      // the machine says where to go, the WebView follows.
      webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(next.target)}; true;`);
    }
    if (next.phase === 'cancelled') close({ kind: 'cancelled' });
    if (next.phase === 'done') {
      const outcome = outcomeRef.current;
      if (outcome) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => close(outcome ? { kind: 'imported', outcome } : { kind: 'empty' }), DISMISS_DELAY_MS);
    }
    // 'error' stays open — the status bar shows what went wrong and the page
    // stays visible; the button becomes Close.
  }, [close]);

  useEffect(() => () => {
    // Unmounted from outside (e.g. parent state reset) — count it as cancel.
    if (!closedRef.current && !isTerminal(stateRef.current)) close({ kind: 'cancelled' });
  }, [close]);

  useEffect(() => {
    // A persisted mode starts the flow straight from mount (no chooseMode).
    if (persistedMode()) recordAudit('refresh-start', `mode ${persistedMode()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseMode = (m: FetchMode) => {
    recordAudit('refresh-start', `mode ${m}`);
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
    recordAudit('continue', urlRef.current);
    dispatchInjected.current = false;
    dispatch({ type: 'handover' });
    if (dispatchInjected.current) return; // this dispatch injected in place (TfL-18)
    if (stateRef.current.phase === 'harvesting') injectHarvest();
  };

  const onLoaded = (url: string) => {
    urlRef.current = url;
    recordAudit('loaded', url);
    dispatchInjected.current = false;
    dispatch({ type: 'loaded', url });
    // Injection is keyed off the phase the machine settles in: paused states
    // never reach 'harvesting' on a load, so login/challenge pages get no
    // script at all (TfL-13).
    if (dispatchInjected.current) return; // this dispatch injected in place (TfL-18)
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
            recordAudit('direct-csv', `csv — ${files.length} file(s)`);
            const cardId = pickCardId(listCards());
            let inserted = 0;
            for (const f of files) {
              recordCsvHit('direct', String(f?.url ?? ''));
              const outcome = importCsvText(String(f?.text ?? ''), `${cardId}.csv`);
              outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
              inserted += outcome.inserted;
            }
            recordAudit('imported', `${inserted} new journeys`);
            dispatch({ type: 'imported', inserted });
          } catch (e) {
            recordAudit('import-failed', String(e));
            dispatch({ type: 'import-failed', message: String(e) });
          }
        } else if (msg.status === 'signed-out' || msg.status === 'challenge') {
          recordAudit('direct-csv', String(msg.status));
          dispatch({ type: 'harvest', status: msg.status });
        } else {
          recordAudit('direct-csv', `${String(msg.status)}: ${String(msg.message ?? msg.href ?? '')}`);
          // wrong-page / failed → steering harvest; from the contactless
          // Dashboard the machine parks for the user instead (TfL-17).
          dispatch({ type: 'direct-failed', url: urlRef.current });
        }
        return;
      }
      if (msg.type !== 'journey-harvest') return;
      const cards = Array.isArray(msg.cards) ? msg.cards : undefined;
      if (msg.status === 'csv' || msg.status === 'rows') {
        if (msg.status === 'csv' && msg.url) recordCsvHit('harvest', String(msg.url));
        recordAudit('harvest', String(msg.status));
        const wasHarvesting = stateRef.current.phase === 'harvesting';
        dispatch({ type: 'harvest', status: msg.status, cards });
        if (!wasHarvesting) return; // duplicate report — this page's import already ran
        try {
          const csv = msg.status === 'csv' ? String(msg.text ?? '') : rowsToCsv(msg.rows ?? []);
          // Filename → card id: reuse the id previous imports stored so the
          // dedupe index treats auto-fetched rows as the same statement.
          const outcome = importCsvText(csv, `${pickCardId(listCards())}.csv`);
          outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
          recordAudit('imported', `${outcome.inserted} new journeys`);
          dispatch({ type: 'imported', inserted: outcome.inserted });
        } catch (e) {
          recordAudit('import-failed', String(e));
          dispatch({ type: 'import-failed', message: String(e) });
        }
        return;
      }
      recordAudit('harvest', `${String(msg.status)}${msg.message ? ` — ${String(msg.message)}` : ''}`);
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
            onPress={() => (capture
              ? close({ kind: 'cancelled' })
              : state.phase === 'error'
                ? close({ kind: 'error', message: state.message })
                : dispatch({ type: 'cancel' }))}
          >
            <Text style={styles.cancelText}>{capture ? 'Done' : finished ? 'Close' : 'Cancel'}</Text>
          </Pressable>
        </View>
        <View style={styles.modeRow}>
          {MODES.map(m => (
            <Pressable
              key={m.value}
              style={[styles.modeChip, !capture && mode === m.value && styles.modeChipActive]}
              onPress={() => {
                // Leaving capture restarts the flow fresh — its WebView was
                // unmounted, so any old flow state is stale (TfL-18).
                if (capture) { setCapture(false); chooseMode(m.value); return; }
                if (mode !== m.value) chooseMode(m.value);
              }}
            >
              <Text style={[styles.modeChipText, !capture && mode === m.value && styles.modeChipTextActive]}>{m.label}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.modeChip, capture && styles.modeChipActive]}
            onPress={() => {
              if (capture) return;
              recordAudit('capture-start');
              setCapture(true);
            }}
          >
            <Text style={[styles.modeChipText, capture && styles.modeChipTextActive]}>Manual</Text>
          </Pressable>
        </View>
        {capture ? (
          <>
            <View style={styles.captureBar}>
              <Text style={styles.captureText}>
                Manual mode — browse the TfL site yourself. Every page and CSV
                you touch is recorded in the Log tab; nothing steers or injects.
              </Text>
            </View>
            <WebView
              key="capture"
              source={{ uri: CAPTURE_URL }}
              style={styles.web}
              sharedCookiesEnabled={true}
              incognito={false}
              onNavigationStateChange={(nav: { url?: string }) => {
                if (nav?.url && nav.url !== urlRef.current) {
                  urlRef.current = String(nav.url);
                  recordAudit('capture-nav', String(nav.url));
                }
              }}
              onShouldStartLoadWithRequest={(req: any) => {
                const url = String(req?.url ?? '');
                if (isCsvEndpoint(url)) {
                  recordAudit('capture-csv', url);
                  recordCsvHit('capture', url);
                }
                return true; // observation only — every request proceeds
              }}
              onFileDownload={({ nativeEvent }: any) => {
                recordAudit('capture-download', String(nativeEvent?.downloadUrl ?? ''));
              }}
            />
          </>
        ) : mode == null ? (
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
                if (nav?.url && nav.url !== urlRef.current) {
                  urlRef.current = String(nav.url);
                  recordAudit('nav', String(nav.url));
                }
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
  captureBar: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: spacing.l,
    marginBottom: spacing.s,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  captureText: { color: colors.text, fontSize: 13 },
});
