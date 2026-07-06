// TfL-11: the journey refresh, visible. A pageSheet modal shows the real TfL
// pages while the TfL-10 harvest script works, with a status bar narrating
// each phase and a Cancel that's safe mid-flow (the import itself is a single
// transaction, so cancelling never leaves half a statement behind). If the
// session has expired the login page is simply there to use — after signing
// in, the flow steers back to the journey history and carries on.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildHarvestScript, JOURNEY_HISTORY_URL, pickCardId, rowsToCsv } from './autofetch';
import { listCards } from './db';
import { importCsvText, ImportOutcome } from './import';
import {
  FlowEvent,
  FlowState,
  INITIAL_FLOW,
  isTerminal,
  reduceFlow,
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

export default function RefreshSheet({ onClose }: Props) {
  const webRef = useRef<WebView>(null);
  const stateRef = useRef<FlowState>(INITIAL_FLOW);
  const outcomeRef = useRef<ImportOutcome | null>(null);
  const closedRef = useRef(false);
  const [state, setState] = useState<FlowState>(INITIAL_FLOW);

  const close = useCallback((r: RefreshResult) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(r);
  }, [onClose]);

  const dispatch = useCallback((e: FlowEvent) => {
    const next = reduceFlow(stateRef.current, e);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    if (next.phase === 'steering') {
      // Wrong landing page (dashboard, card list…) or the next card's history:
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

  const onLoaded = (url: string) => {
    dispatch({ type: 'loaded', url });
    // Harvest every landed page — the script reports what the page is
    // (challenge, login, wrong page, card picker, history) and the machine
    // reacts. Login/challenge pages are the user's to use, nothing injected.
    if (stateRef.current.phase === 'harvesting') {
      webRef.current?.injectJavaScript(buildHarvestScript());
    }
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
      if (msg.type !== 'journey-harvest') return;
      const cards = Array.isArray(msg.cards) ? msg.cards : undefined;
      if (msg.status === 'csv' || msg.status === 'rows') {
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
        <View style={[styles.statusBar, state.phase === 'error' && styles.statusBarError]}>
          <Text style={styles.statusText}>{statusText(state)}</Text>
        </View>
        <WebView
          ref={webRef}
          source={{ uri: JOURNEY_HISTORY_URL }}
          style={styles.web}
          // Session reuse, not session capture: the cookie stays in the shared
          // system WebView store — the app never reads or persists credentials.
          sharedCookiesEnabled={true}
          incognito={false}
          onLoadEnd={(e: any) => onLoaded(String(e?.nativeEvent?.url ?? ''))}
          onNavigationStateChange={(nav: { url?: string }) => dispatch({ type: 'nav', url: String(nav?.url ?? '') })}
          onError={() => dispatch({ type: 'web-error', message: 'page failed to load' })}
          onMessage={onMessage}
        />
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
  statusBar: {
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
  statusText: { color: colors.text, fontSize: 13 },
  web: { flex: 1, backgroundColor: '#fff' },
});
