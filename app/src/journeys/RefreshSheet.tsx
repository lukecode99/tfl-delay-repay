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
// records. TfL-20: that capture WebView also instruments the page's own
// network traffic (fetch/XHR/form posts) so walking through one real Delay
// Repay claim records the claim endpoint and payload in the log.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Alert, Animated, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { buildNetCaptureScript, describeCapture } from './claim-capture';
import {
  buildDirectCsvScript,
  cardIdsFromLog,
  deepPullMetaKeyFor,
  DEEP_PULL_META_KEY,
  extractCardDisplayId,
  HISTORY_MONTHS,
  isCsvDownloadUrl,
  isDeepPullComplete,
  isDirectCsvUrl,
  lastNPeriods,
  looksLikeCsv,
  MAX_DIRECT_CARDS,
  mergeDeepPullCoverage,
  PASS_PERIODS,
  pendingDeepPullPeriods,
  periodsForRefresh,
  PER_JOB_MS,
} from './direct-csv';
import { autoMatchRefunds } from '../claims/auto-match';
import { setClaimOutcome } from '../claims/db';
import { getMeta, insertRefunds, listCards, setMeta } from './db';
import { importCsvText, ImportOutcome } from './import';
import { isJourneyCsv, parseStatement } from './parse';
import { saveRawStatements } from './raw-export-io';
import type { RawStatement } from './raw-export';
import {
  canHandover,
  FETCH_MODE_KEY,
  FetchMode,
  FlowEvent,
  FlowState,
  isPaused,
  isTerminal,
  makeInitialFlow,
  progressOf,
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

// TfL-LOGIN-FIRST: lightweight read-only DOM scan injected during paused states.
// Unlike the harvest script this never navigates or modifies the page — it only
// reads the DOM and posts back one message so the banner copy can re-evaluate
// per navigation while the user is working through sign-in. Captcha stays
// entirely the user's: no injection there alters the flow.
// TfL-LOGIN-FIRST: lightweight read-only DOM scan injected during paused states.
// TfL-SIGNIN-DIRECT: also scans by href so /UnregisteredCustomer/Captcha pages
// (which link to sign-in but use non-standard link text) can still be steered.
const PAUSED_SCAN_SCRIPT = `(function () {
  try {
    var pw = !!document.querySelector('input[type="password"]');
    var bodyText = document.body ? document.body.innerText : '';
    var quota = /recaptcha/i.test(bodyText) && /quota|exceeded|error for site owner/i.test(bodyText);
    var signinHref = null;
    var links = document.querySelectorAll('a[href]');
    // Primary: exact "Sign in" / "Log in" anchor text (TfL-LOGIN-FIRST).
    for (var i = 0; i < links.length; i++) {
      var t = (links[i].textContent || '').trim();
      if (/^sign ?in$|^log ?in$/i.test(t)) { signinHref = links[i].href; break; }
    }
    // Fallback: any anchor whose href contains a sign-in path, for pages where
    // TfL uses non-standard label text (e.g. /UnregisteredCustomer/Captcha).
    if (!signinHref) {
      for (var i = 0; i < links.length; i++) {
        var h = links[i].href || '';
        if (/\/signin|\/sign-in|\/login\b/i.test(h) && !/sign.?out|log.?out/i.test(h)) {
          signinHref = h; break;
        }
      }
    }
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'paused-page-scan',
        hasPassword: pw,
        signinHref: signinHref,
        quotaNotice: quota,
      }));
    }
  } catch (e) {}
})(); true;`;

function persistedMode(): FetchMode | null {
  const m = getMeta(FETCH_MODE_KEY);
  return m === 'contactless' || m === 'oyster' || m === 'both' ? m : null;
}

// TfL-18: has this flow state already made its in-place direct CSV attempt?
function directTried(s: FlowState): boolean {
  return 'directTried' in s && s.directTried === true;
}

/**
 * Browser controls (TfL-25).
 *
 * Luke, 29-Jul: "The browser doesn't let me accept cookies or go back." The
 * second half of that was literally true — the sheet's only control was Cancel,
 * which closes the whole refresh. A WKWebView has no chrome of its own, so a
 * user stuck on any page TfL served had no way out except abandoning the job.
 *
 * Three controls, on both WebViews, because the report came from Manual mode:
 * Back for a page you didn't want, Reload for a page that half-loaded, and
 * Safari for anything the in-app view can't finish (a bank's 3-D Secure step,
 * a download, a password manager). Safari is the honest escape hatch: the
 * session cookie is the shared system one, so signing in out there counts in
 * here.
 */
function BrowserBar({ web, canGoBack, url }: {
  web: React.RefObject<WebView | null>;
  canGoBack: boolean;
  url: string;
}) {
  return (
    <View style={styles.browserBar}>
      <Pressable
        style={[styles.browserButton, !canGoBack && styles.browserButtonOff]}
        hitSlop={8}
        disabled={!canGoBack}
        onPress={() => web.current?.goBack()}
      >
        <Text style={[styles.browserText, !canGoBack && styles.browserTextOff]}>‹ Back</Text>
      </Pressable>
      <Pressable style={styles.browserButton} hitSlop={8} onPress={() => web.current?.reload()}>
        <Text style={styles.browserText}>Reload</Text>
      </Pressable>
      <View style={styles.browserSpacer} />
      <Pressable
        style={styles.browserButton}
        hitSlop={8}
        disabled={!url}
        onPress={() => { if (url) Linking.openURL(url).catch(() => { }); }}
      >
        <Text style={[styles.browserText, !url && styles.browserTextOff]}>Open in Safari</Text>
      </Pressable>
    </View>
  );
}

/**
 * The progress bar Luke asked for (msg 4608: "it needs a progress bar or
 * something").
 *
 * Determinate (progressOf returns non-null): standard fill-track with label.
 * Indeterminate (progressOf null, active phase): animated pulsing track with
 *   statusText — Oyster mode never gets a card count, so "frozen at 0%"
 *   becomes a smooth animation that confirms the machine is working.
 * Nothing (terminal or paused): no bar — a bar under "sign in" claims progress
 *   that isn't happening; the status line covers those states.
 *
 * The total can grow mid-refresh, because TfL only reveals how many cards are
 * on the account partway through. "Page 2 of 3" becoming "Page 2 of 5" is the
 * truth; a bar that filled and then kept working would not be.
 */
function ProgressBar({ state }: { state: FlowState }) {
  const p = progressOf(state);
  const isActive = !isPaused(state) && !isTerminal(state);
  const showIndeterminate = p === null && isActive;
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!showIndeterminate) { anim.setValue(0); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [showIndeterminate, anim]);

  if (p !== null) {
    return (
      <View style={styles.progressWrap}>
        <View style={styles.progressTrack}>
          {/* Two flex weights rather than a percentage width: `flex` is a plain
              number, so this can't trip over RN's DimensionValue template-literal
              type — and there is no node_modules in this workspace to type-check
              against, so the formulation that can't fail is the right one. */}
          <View style={[styles.progressFill, { flex: p.fraction }]} />
          <View style={{ flex: 1 - p.fraction }} />
        </View>
        <Text style={styles.progressLabel}>{p.label}</Text>
      </View>
    );
  }

  if (!isActive) return null;

  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, { flex: 1, opacity }]} />
      </View>
      <Text style={styles.progressLabel}>{statusText(state)}</Text>
    </View>
  );
}

export default function RefreshSheet({ onClose }: Props) {
  const webRef = useRef<WebView>(null);
  const urlRef = useRef(''); // last URL the WebView reported — picks the injected script
  const stateRef = useRef<FlowState>(makeInitialFlow('contactless'));
  const outcomeRef = useRef<ImportOutcome | null>(null);
  const closedRef = useRef(false);
  // REFUND-AUTO-MATCH: accumulated across billing files in this session.
  const sessionAutoMatchedRef = useRef(0);
  const sessionCorrectionsRef = useRef<Array<{ journeyId: number; suggested: number }>>([]);
  // TfL-18: set while a dispatch() call injects the in-place direct script,
  // so the handler that triggered it doesn't inject a second time.
  const dispatchInjected = useRef(false);
  // Harvest timeout — cleared whenever the phase leaves 'harvesting'.
  const harvestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remaining backfill months shown in the status bar during direct-csv passes.
  const [pendingPeriods, setPendingPeriods] = useState(0);
  // TfL-DEEPPULL-PROOF: capture what the current directScript() call requested
  // so the message handler can compare covered vs requested without recomputing
  // nowISO (which could shift at midnight between call and response).
  const requestedPeriodsRef = useRef<string[]>([]);
  const requestedNowISORef = useRef<string>('');
  // null = never chosen: the sheet opens with the chooser and no WebView.
  const [mode, setMode] = useState<FetchMode | null>(persistedMode);
  // Per-leg label shown in the status bar when phase = 'harvesting'.
  const [legLabel, setLegLabel] = useState<string>('');
  // TfL-18: Manual capture — the user drives, the app only records.
  const [capture, setCapture] = useState(false);
  // TfL-25: the browser bar needs these in render, so they're state rather than
  // the urlRef the audit log uses. One pair for both WebViews — only one is
  // ever mounted, and switching mode remounts it (hence the resets below).
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  // TfL-LOGIN-FIRST: banner copy override while paused. Cleared on each new
  // page load and reset by the PAUSED_SCAN_SCRIPT result (paused-page-scan).
  const [pausedCopy, setPausedCopy] = useState<string | null>(null);
  // TfL-19: capture mode now IMPORTS tapped statement downloads too — the
  // WebView needs a ref (to inject the page-context fetch; a native fetch
  // would bounce off the WAF), a dedupe set (Download taps repeat), and a
  // status line so a tap visibly does something.
  const captureRef = useRef<WebView>(null);
  const captureFetched = useRef<Set<string>>(new Set());
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
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
    const nowISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Backfill: fetch up to PASS_PERIODS uncovered months per pass. Routine:
    // current + previous only. isDeepPullComplete rejects legacy 'done' so
    // existing installs re-pull once to establish period-level proof.
    const meta = getMeta(deepPullMetaKeyFor(mode ?? 'contactless'));
    const periods = periodsForRefresh(nowISO, meta);
    requestedPeriodsRef.current = periods;
    requestedNowISORef.current = nowISO;
    // pendingPeriods drives the status bar: shows "N months remaining" during
    // the incremental backfill so the user knows a multi-refresh fill is underway.
    setPendingPeriods(pendingDeepPullPeriods(nowISO, meta));
    const routineWindow = lastNPeriods(nowISO, PASS_PERIODS);
    return buildDirectCsvScript(periods, cardIdsFromLog(getMeta(CSV_LOG_KEY)), routineWindow);
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

    // Clear harvest timeout whenever the phase leaves 'harvesting'.
    if (prev.phase === 'harvesting' && next.phase !== 'harvesting') {
      if (harvestTimerRef.current != null) {
        clearTimeout(harvestTimerRef.current);
        harvestTimerRef.current = null;
      }
    }

    if (next.phase !== prev.phase) {
      recordAudit('phase', next.phase + (next.phase === 'steering' ? ` → ${next.target}` : ''));
    }

    // TfL-REFRESH-HANG: start a 30s watchdog whenever entering 'harvesting'.
    // If the phase is still 'harvesting' when it fires, treat it as a failed
    // direct attempt so the flow can recover (steer or advance) rather than
    // spinning forever — most common when the Oyster leg never reports back.
    if (next.phase === 'harvesting' && (prev.phase !== 'harvesting' || e.type === 'handover')) {
      harvestTimerRef.current = setTimeout(() => {
        if (stateRef.current.phase === 'harvesting') {
          recordAudit('harvest-timeout', urlRef.current);
          dispatch({ type: 'direct-failed', url: urlRef.current });
        }
      }, 30_000);
    }

    // TfL-18: queue exhausted → the direct CSV attempt happens in place, so
    // no page load will ever fire to trigger injection — inject on the
    // transition itself. The ref stops the calling handler doubling up.
    if (next.phase === 'harvesting' && directTried(next) && !directTried(prev)) {
      dispatchInjected.current = true;
      injectDirect(); // sets requestedPeriodsRef.current via directScript()
      // Override the 30s classic-harvest watchdog with a budget scaled to the
      // actual job count: periods × cards × 2 (journey pass + billing pass) ×
      // per-job allowance. The billing pass runs AFTER journey files are
      // reported and the phase leaves 'harvesting', so only the journey pass
      // needs to complete within this window.
      if (harvestTimerRef.current != null) clearTimeout(harvestTimerRef.current);
      harvestTimerRef.current = setTimeout(() => {
        if (stateRef.current.phase === 'harvesting') {
          recordAudit('harvest-timeout', urlRef.current);
          dispatch({ type: 'direct-failed', url: urlRef.current });
        }
      }, 30_000 + (requestedPeriodsRef.current.length || PASS_PERIODS) * MAX_DIRECT_CARDS * 2 * PER_JOB_MS);
    }
    // Paused states entered via harvest reports (e.g. bounce into signed-out)
    // get no page load, so onLoaded never fires the scan. Inject here instead.
    if (isPaused(next) && !isPaused(prev)) webRef.current?.injectJavaScript(PAUSED_SCAN_SCRIPT);
    if (next.phase === 'steering') {
      // Wrong landing page (dashboard, card list…) or the next queued page:
      // the machine says where to go, the WebView follows.
      webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(next.target)}; true;`);
    }
    if (next.phase === 'cancelled') close({ kind: 'cancelled' });
    if (next.phase === 'done') {
      const outcome = outcomeRef.current;
      if (outcome) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const n = sessionAutoMatchedRef.current;
      if (n > 0) {
        // Fold the auto-match count into the status banner alongside the done message.
        setPausedCopy(`${next.message} · ${n} claim${n === 1 ? '' : 's'} auto-marked paid`);
      }
      const doClose = () => close(outcome ? { kind: 'imported', outcome } : { kind: 'empty' });
      // Dedupe by journeyId — a journey appearing in two billing files would
      // otherwise prompt twice for the same claim.
      const seenJourneys = new Set<number>();
      const pendingCorrections = sessionCorrectionsRef.current.filter(c => {
        if (seenJourneys.has(c.journeyId)) return false;
        seenJourneys.add(c.journeyId);
        return true;
      });
      if (pendingCorrections.length > 0) {
        // Present each correction in sequence. Never auto-writes — the user
        // decides whether each suggested amount is right. Close after all handled.
        const offerNext = (remaining: typeof pendingCorrections) => {
          if (!remaining.length) { doClose(); return; }
          const [c, ...rest] = remaining;
          Alert.alert(
            'Refund amount found',
            `Your billing statement shows a £${c.suggested.toFixed(2)} credit that matches a claim already marked paid but with no amount recorded. Record £${c.suggested.toFixed(2)} as the paid amount?`,
            [
              { text: 'Skip', style: 'cancel', onPress: () => offerNext(rest) },
              { text: 'Record', onPress: () => { setClaimOutcome(c.journeyId, 'paid', c.suggested); offerNext(rest); } },
            ],
          );
        };
        setTimeout(() => offerNext(pendingCorrections), DISMISS_DELAY_MS);
      } else {
        setTimeout(doClose, DISMISS_DELAY_MS);
      }
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
    sessionAutoMatchedRef.current = 0;
    sessionCorrectionsRef.current = [];
    setPendingPeriods(0);
    stateRef.current = makeInitialFlow(m);
    setState(stateRef.current);
    // TfL-25: the WebView remounts on mode change (key={mode}), so its
    // back/forward list goes with it. Leaving canGoBack true would offer a
    // ‹ Back button that does nothing.
    setCanGoBack(false);
    setPageUrl('');
    setPausedCopy(null);
    setMode(m);
  };

  // Continue button (TfL-13): resume from login/challenge, or force a harvest
  // of whatever page the user navigated to themselves.
  const onContinue = () => {
    recordAudit('continue', urlRef.current);
    if (stateRef.current.phase === 'harvesting') {
      // Re-tapping Continue while already harvesting changes nothing visible —
      // show brief feedback so Luke knows the tap registered.
      setPausedCopy('Re-reading this page…');
      setTimeout(() => setPausedCopy(p => p === 'Re-reading this page…' ? null : p), 1500);
    } else {
      setPausedCopy(null);
    }
    dispatchInjected.current = false;
    dispatch({ type: 'handover' });
    if (dispatchInjected.current) return; // this dispatch injected in place (TfL-18)
    if (stateRef.current.phase === 'harvesting') injectHarvest();
  };

  const onLoaded = (url: string) => {
    urlRef.current = url;
    recordAudit('loaded', url);
    dispatchInjected.current = false;
    // Clear the previous page's banner override — the scan below will set a
    // new one if this page warrants it (TfL-LOGIN-FIRST).
    setPausedCopy(null);
    // Per-leg label for the status bar in 'both' mode.
    if (/oyster\.tfl\.gov\.uk/i.test(url)) setLegLabel('Oyster');
    else if (/contactless\.tfl\.gov\.uk/i.test(url)) setLegLabel('contactless');
    dispatch({ type: 'loaded', url });
    // Injection is keyed off the phase the machine settles in.
    // Harvest script: harvesting phase only — login/challenge pages get none (TfL-13).
    // Paused-scan script: read-only DOM probe that re-evaluates banner copy so
    // the user sees context-appropriate text as they step through sign-in pages.
    // It never navigates or modifies the page, preserving TfL-13's no-steering
    // guarantee.
    if (dispatchInjected.current) return; // this dispatch injected in place (TfL-18)
    if (stateRef.current.phase === 'harvesting') injectHarvest();
    else if (isPaused(stateRef.current)) webRef.current?.injectJavaScript(PAUSED_SCAN_SCRIPT);
  };

  // Several cards can each contribute an import (TfL-12) — merge the tallies
  // so the closing summary covers the whole refresh.
  const mergeOutcome = (a: ImportOutcome | null, b: ImportOutcome): ImportOutcome => (a ? {
    ...b,
    inserted: a.inserted + b.inserted,
    upgraded: a.upgraded + b.upgraded,
    duplicates: a.duplicates + b.duplicates,
    incomplete: a.incomplete + b.incomplete,
    filesChecked: a.filesChecked + b.filesChecked,
    refundsInserted: a.refundsInserted + b.refundsInserted,
    parsed: { ...b.parsed, skipped: a.parsed.skipped + b.parsed.skipped },
  } : b);

  // TfL-19: a statement download tapped in capture mode used to be a dead end
  // (iOS WebViews don't download files — three builds of silent taps). Now the
  // tap triggers a page-context fetch of the same URL, and the response comes
  // back through onCaptureMessage for a real import.
  const captureFetch = (url: string) => {
    if (!url || captureFetched.current.has(url)) return;
    captureFetched.current.add(url);
    recordAudit('capture-fetch', url);
    setCaptureStatus('Fetching statement…');
    captureRef.current?.injectJavaScript(`(function () {
  fetch(${JSON.stringify(url)}, { credentials: 'include' })
    .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.text(); })
    .then(function (t) {
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'capture-fetch', url: ${JSON.stringify(url)}, text: t })); }
    })
    .catch(function (e) {
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'capture-fetch', url: ${JSON.stringify(url)}, error: String(e) })); }
    });
})(); true;`);
  };

  const onCaptureMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      // TfL-20: the capture WebView instruments the page's own traffic —
      // fetch/XHR/form posts land here and go straight to the audit log, so
      // walking through one real claim records its endpoint and payload.
      if (msg.type === 'net-capture') { recordAudit('net-capture', describeCapture(msg)); return; }
      if (msg.type !== 'capture-fetch') return;
      if (msg.error) {
        recordAudit('capture-import-failed', `${String(msg.url ?? '')} — ${String(msg.error)}`);
        setCaptureStatus('Statement fetch failed — try tapping it again.');
        captureFetched.current.delete(String(msg.url ?? '')); // allow a retry
        return;
      }
      const text = String(msg.text ?? '');
      if (!looksLikeCsv(text)) {
        recordAudit('capture-import-failed', `not a CSV (signed out?) — first line "${(text.split(/\r?\n/)[0] ?? '').slice(0, 120)}"`);
        setCaptureStatus('That download wasn’t a statement CSV — are you signed in?');
        return;
      }
      const fromUrl = extractCardDisplayId(String(msg.url ?? ''));
      const outcome = importCsvText(text, `${pickCardId(listCards(), fromUrl ?? undefined)}.csv`);
      outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
      recordAudit('capture-imported', outcome.parsed.journeys.length === 0
        ? `0 journeys (skipped ${outcome.parsed.skipped}) — header "${(text.split(/\r?\n/)[0] ?? '').slice(0, 120)}"`
        : `parsed ${outcome.parsed.journeys.length}, inserted ${outcome.inserted}, duplicates ${outcome.duplicates}`);
      setCaptureStatus(outcome.inserted > 0
        ? `Imported ${outcome.inserted} new journey${outcome.inserted === 1 ? '' : 's'}.`
        : outcome.parsed.journeys.length > 0
          ? 'Statement fetched — all journeys already imported.'
          : 'Statement fetched but held no journeys.');
      if (outcome.inserted > 0) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch { /* not ours */ }
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'paused-page-scan') {
        // TfL-SIGNIN-DIRECT (criterion 6): log which classifier fired, what
        // phase we're in, and whether a sign-in href was found. Highest-value
        // line in the audit trail — 10-minute root-cause vs a day of guessing.
        const scanClassifier = msg.quotaNotice ? 'quota' : msg.hasPassword ? 'password'
          : msg.signinHref ? 'signinHref' : 'none';
        recordAudit('paused-scan', `phase=${stateRef.current.phase} classifier=${scanClassifier}${msg.signinHref ? ` href=${String(msg.signinHref).slice(0, 80)}` : ''}`);
        // TfL-LOGIN-FIRST: re-evaluate banner copy per page during pause.
        // reCAPTCHA quota notices are TfL's billing problem, not ours —
        // say so explicitly rather than leaving the user wondering.
        if (msg.quotaNotice) {
          setPausedCopy("TfL's reCAPTCHA is over its daily quota — this is a TfL issue, not ours. Try again later.");
        } else if (msg.hasPassword) {
          setPausedCopy('Enter your TfL login details, then tap Continue.');
        } else if (msg.signinHref) {
          // Sign In anchor found on the signed-out page — follow TfL's own
          // routing rather than guessing a URL. The reducer enforces the
          // single-steer bounce guard (signinSteered).
          dispatch({ type: 'signin-nav', url: String(msg.signinHref) });
        } else if (stateRef.current.phase === 'signed-out') {
          // TfL-SIGNIN-DIRECT: both DOM scans (text + href) came back empty —
          // gate pages like /UnregisteredCustomer/Captcha carry no discoverable
          // sign-in anchor. Steer to the known-good URL proven in Luke's log.
          // signinSteered latch in the reducer absorbs any repeat if TfL bounces
          // back to the gate, so this fires at most once per run.
          const fallbackUrl = /oyster\.tfl\.gov\.uk/i.test(urlRef.current)
            ? 'https://accounts.tfl.gov.uk/adapter/signin'
            : 'https://contactless.tfl.gov.uk/HomePage/Login';
          recordAudit('signin-fallback', `mode=${mode ?? 'unknown'} url=${fallbackUrl}`);
          dispatch({ type: 'signin-nav', url: fallbackUrl });
        }
        // Other paused pages (captcha, marketing): statusText(state) is correct.
        return;
      }
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
            // Card list snapshotted before the loop: existing imports keep
            // their dedupe key; a fresh install falls back to each file's own
            // card id, so multiple cards stay separate (TfL-19).
            const existingCards = listCards();
            let inserted = 0;
            const rawFiles: RawStatement[] = [];
            for (const f of files) {
              recordCsvHit('direct', String(f?.url ?? ''));
              const text = String(f?.text ?? '');
              const fileCard = String(f?.card ?? '').trim();
              const filePeriod = String(f?.period ?? '');
              // Keep the raw text so the user can export the unparsed statements
              // (TfL-23) — including rows the importer skips as non-rail.
              rawFiles.push({ period: filePeriod, card: fileCard, text });
              const outcome = importCsvText(text, `${pickCardId(existingCards, fileCard || undefined)}.csv`, filePeriod);
              outcomeRef.current = mergeOutcome(outcomeRef.current, outcome);
              inserted += outcome.inserted;
              // Per-file audit (TfL-19): a zero-parse file logs its header
              // line — that's how the billing-vs-journey mixup stayed
              // invisible through three builds.
              const tag = `${fileCard.slice(0, 8) || '????????'}… ${filePeriod || '?'}`;
              recordAudit('direct-file', outcome.parsed.journeys.length === 0
                ? `${tag}: 0 journeys (skipped ${outcome.parsed.skipped}) — header "${(text.split(/\r?\n/)[0] ?? '').slice(0, 120)}"`
                : `${tag}: parsed ${outcome.parsed.journeys.length}, inserted ${outcome.inserted}, duplicates ${outcome.duplicates}`);
              if (outcome.parsed.diagnosticSkips.length > 0) {
                recordAudit('refund-candidates', outcome.parsed.diagnosticSkips
                  .map(s => `${s.date} "${s.rawAction}" £${s.credit.toFixed(2)}`).join('; '));
              }
            }
            // Accumulate covered periods into the deep-pull marker. The app only
            // switches to 2-month routine once isDeepPullComplete proves every
            // HISTORY_MONTHS period. Legacy 'done' is treated as unproven by
            // isDeepPullComplete, so existing installs re-pull once automatically.
            // Partial passes update the marker but don't trigger the mode switch.
            const coveredPeriods = files
              .filter((f: any) => isJourneyCsv(String(f?.text ?? '')))
              .map((f: any) => String(f?.period ?? ''))
              .filter(Boolean);
            const requested = requestedPeriodsRef.current;
            // scopeComplete: this specific run covered every period it requested.
            // False on a partial pass — withholds "already up to date" in doneMessage.
            const scopeComplete = requested.length === 0 || requested.every(p => coveredPeriods.includes(p));
            const dpKey = deepPullMetaKeyFor(mode ?? 'contactless');
            const updatedMeta = mergeDeepPullCoverage(getMeta(dpKey), coveredPeriods);
            setMeta(dpKey, updatedMeta);
            const dpNowISO = requestedNowISORef.current ||
              `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
            if (isDeepPullComplete(updatedMeta, dpNowISO)) {
              recordAudit('deep-pull-complete', `${coveredPeriods.length} period(s) proven`);
            } else {
              const shortfall = requested.filter(p => !coveredPeriods.includes(p)).length;
              recordAudit('deep-pull-partial', `${coveredPeriods.length}/${requested.length} this pass, ${shortfall} missing`);
            }
            recordAudit('imported', `${inserted} new journeys`);
            // Persist the raw statements for the Export CSV button (fire and
            // forget — the import result must not wait on a share file).
            saveRawStatements(rawFiles)
              .then(nn => recordAudit('raw-export', `saved ${nn} raw statement(s)`))
              .catch(e => recordAudit('raw-export', `save failed: ${String(e)}`));
            dispatch({ type: 'imported', inserted, scopeComplete });
          } catch (e) {
            recordAudit('import-failed', String(e));
            dispatch({ type: 'import-failed', message: String(e) });
          }
        } else if (msg.status === 'billing') {
          // Billing supplement arrives after journey files are already banked
          // and the phase has left 'harvesting'. Process refunds without any
          // state transition — billing is non-fatal and its delay must not
          // block or undo the journey import.
          const billingFiles = Array.isArray(msg.billingFiles) ? msg.billingFiles : [];
          let billingRefunds = 0;
          for (const bf of billingFiles) {
            try {
              const btext = String(bf?.text ?? '');
              const bcard = String(bf?.card ?? '').trim() || 'unknown';
              const bperiod = String(bf?.period ?? '');
              if (looksLikeCsv(btext)) {
                const bparsed = parseStatement(btext, bcard);
                if (bparsed.refunds.length > 0) {
                  const { inserted: ri } = insertRefunds(bparsed.refunds, bcard, bperiod);
                  billingRefunds += ri;
                  const { matched, corrections } = autoMatchRefunds(bparsed.refunds);
                  if (matched > 0) {
                    recordAudit('auto-match', `${matched} claim(s) marked paid`);
                    sessionAutoMatchedRef.current += matched;
                  }
                  if (corrections.length > 0) {
                    recordAudit('auto-match-review', corrections
                      .map(c => `journey ${c.journeyId}: suggested £${c.suggested.toFixed(2)}`)
                      .join('; '));
                    sessionCorrectionsRef.current.push(...corrections);
                  }
                }
              }
            } catch { /* non-fatal */ }
          }
          if (billingFiles.length > 0) recordAudit('billing-csv', `${billingFiles.length} files, ${billingRefunds} new refunds`);
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
              // TfL-19: capture can import now — Done reports what landed so
              // the journeys list refreshes, instead of always "cancelled".
              ? close(outcomeRef.current
                ? { kind: 'imported', outcome: outcomeRef.current }
                : { kind: 'cancelled' })
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
              // TfL-25: a different WebView mounts here, with its own empty
              // history — the flow view's back state doesn't carry over.
              setCanGoBack(false);
              setPageUrl('');
              setCapture(true);
            }}
          >
            <Text style={[styles.modeChipText, capture && styles.modeChipTextActive]}>Manual</Text>
          </Pressable>
        </View>
        {!capture && (mode === 'oyster' || mode === 'both') ? (
          <Text style={styles.modeNote}>Oyster history is limited to ~8 weeks on TfL's site.</Text>
        ) : null}
        {capture ? (
          <>
            <View style={styles.captureBar}>
              <Text style={styles.captureText}>
                {captureStatus ?? 'Manual mode — browse the TfL site yourself. '
                  + 'Tap a statement download and the app fetches and imports '
                  + 'it; everything is recorded in the Log tab.'}
              </Text>
            </View>
            <WebView
              key="capture"
              ref={captureRef}
              source={{ uri: CAPTURE_URL }}
              style={styles.web}
              sharedCookiesEnabled={true}
              incognito={false}
              // TfL-25: swipe-back, the gesture users try before they look for
              // a button. Off by default in react-native-webview.
              allowsBackForwardNavigationGestures={true}
              // TfL-20: record the page's outbound traffic (fetch/XHR/form
              // posts) so one manual claim reveals the claim endpoint and
              // payload for later direct submission. Re-injected per page
              // load; the script's own window flag stops double-patching.
              injectedJavaScript={buildNetCaptureScript()}
              onNavigationStateChange={(nav: { url?: string; canGoBack?: boolean }) => {
                if (nav?.url && nav.url !== urlRef.current) {
                  urlRef.current = String(nav.url);
                  recordAudit('capture-nav', String(nav.url));
                }
                setCanGoBack(nav?.canGoBack === true);
                setPageUrl(String(nav?.url ?? ''));
              }}
              onShouldStartLoadWithRequest={(req: any) => {
                const url = String(req?.url ?? '');
                if (isCsvEndpoint(url)) {
                  recordAudit('capture-csv', url);
                  recordCsvHit('capture', url);
                }
                // TfL-19: a statement download itself gets fetched in page
                // context and imported — the WebView can't save files, so
                // this is what makes the tap do anything at all.
                if (isCsvDownloadUrl(url)) captureFetch(url);
                return true; // requests still proceed untouched
              }}
              onFileDownload={({ nativeEvent }: any) => {
                const url = String(nativeEvent?.downloadUrl ?? '');
                recordAudit('capture-download', url);
                if (isCsvDownloadUrl(url)) captureFetch(url);
              }}
              onMessage={onCaptureMessage}
            />
            <BrowserBar web={captureRef} canGoBack={canGoBack} url={pageUrl} />
          </>
        ) : mode == null ? (
          <View style={styles.chooser}>
            <Text style={styles.chooserTitle}>How do you travel?</Text>
            <Text style={styles.chooserBody}>
              Pick where your journeys live so the refresh opens the right
              history — contactless bank cards, or an Oyster card (up to ~8
              weeks of history), or both. You can change this any time using
              the buttons above.
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.statusBar, state.phase === 'error' && styles.statusBarError]}>
              <Text style={styles.statusText}>
                {pausedCopy != null
                  ? pausedCopy
                  : state.phase === 'harvesting' && pendingPeriods > 0
                    ? `Fetching history — ${pendingPeriods} month${pendingPeriods === 1 ? '' : 's'} remaining…`
                    : state.phase === 'harvesting' && legLabel
                      ? `Reading your ${legLabel} journey history…`
                      : statusText(state)}
              </Text>
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
            <ProgressBar state={state} />
            <WebView
              key={mode}
              ref={webRef}
              source={{ uri: startUrlFor(mode) }}
              style={styles.web}
              // Session reuse, not session capture: the cookie stays in the shared
              // system WebView store — the app never reads or persists credentials.
              sharedCookiesEnabled={true}
              incognito={false}
              // TfL-25: swipe-back. Safe with the state machine — a user-driven
              // navigation arrives as a normal 'nav' event, and while paused the
              // reducer ignores it entirely (that's the TfL-13 guarantee).
              allowsBackForwardNavigationGestures={true}
              onLoadEnd={(e: any) => onLoaded(String(e?.nativeEvent?.url ?? ''))}
              onNavigationStateChange={(nav: { url?: string; title?: string; canGoBack?: boolean }) => {
                if (nav?.url && nav.url !== urlRef.current) {
                  urlRef.current = String(nav.url);
                  recordAudit('nav', String(nav.url));
                }
                setCanGoBack(nav?.canGoBack === true);
                setPageUrl(String(nav?.url ?? ''));
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
            <BrowserBar web={webRef} canGoBack={canGoBack} url={pageUrl} />
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
    // TfL-25: four chips (Contactless / Oyster / Both / Manual) don't fit one
    // line on a 390pt-wide phone, and without wrapping the last one is simply
    // cut off at the screen edge — visible in Luke's 29-Jul screenshot. A row
    // that wraps is better than a scroller here: nothing is hidden, and the
    // chips are a mode switch, not a list.
    flexWrap: 'wrap',
    gap: spacing.s,
    rowGap: spacing.s,
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
  modeNote: { color: colors.textDim, fontSize: 11, paddingHorizontal: spacing.l, paddingBottom: spacing.s },
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
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s,
    marginHorizontal: spacing.l,
    marginBottom: spacing.s,
  },
  progressTrack: {
    flex: 1,
    flexDirection: 'row',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.cardBorder,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.accentBright },
  progressLabel: { color: colors.textDim, fontSize: 11 },
  browserBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s,
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    paddingHorizontal: spacing.l,
    paddingVertical: spacing.s,
  },
  browserButton: { paddingVertical: 4, paddingHorizontal: spacing.s },
  browserButtonOff: { opacity: 0.4 },
  browserSpacer: { flex: 1 },
  browserText: { color: colors.accentBright, fontSize: 14, fontWeight: '600' },
  browserTextOff: { color: colors.textDim },
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
