// TfL-6: guided claim filing. Opens the TfL service-delay-refund flow in a
// WebView with an assist bar: one-tap copy chips for every claim value, a
// "Fill form" button that runs the keyword-heuristic inject script, and
// "Mark claimed" for when the user has submitted on the TfL page.
//
// Deliberate (design principles): the user signs in and submits on tfl.gov.uk
// themselves — no credential storage, no automated submission.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { markClaimed } from '../claims/db';
import { buildFillScript, buildPrefill, PrefillField } from '../claims/prefill';
import { buildApplyPlan, buildDirectFillScript } from '../claims/apply-fill';
import { buildClaimConfirmScanScript } from '../claims/claim-confirm-scan';
import { buildCardSelectScript, cardIdFromSelectBody, CONTACTLESS_MYCARDS_URL, isDashboardPage, isLoginRedirectUrl, isMyCardsPage, lastFourOf, PREFERRED_CARD_KEY, tidyNavLogUrl } from '../claims/card-select';
import { primaryCardDisplayId } from '../journeys/direct-csv';
import { CSV_LOG_KEY } from '../journeys/autofetch';
import type { Assessment } from '../eligibility/engine';
import type { StoredJourney } from '../journeys/db';
import { getMeta, setMeta } from '../journeys/db';
import { appendAudit, AUDIT_LOG_KEY } from '../journeys/audit-log';
import { buildNetCaptureScript, describeCapture } from '../journeys/claim-capture';
import { colors, spacing } from '../theme';

interface Props {
  journey: StoredJourney;
  assessment: Assessment | undefined;
  onDone: (claimed: boolean) => void;
}

// TfL-34: the guided claim's visible stages, in order. Index drives the
// progress stepper at the top of the screen (see stageIdx / bumpStage).
const STAGES = ['Sign in', 'Identify card', 'Open form', 'Fill form', 'Submit'];

export default function ClaimWebScreen({ journey, assessment, onDone }: Props) {
  const webRef = useRef<WebView>(null);
  const fields = useMemo(() => buildPrefill(journey, assessment), [journey, assessment]);
  // TfL-21: the Apply page's dropdowns (Mode select + station typeaheads) can't
  // be driven by keyword heuristics — they set hidden numeric fields (ModeId /
  // Start-/FinishNlcId). This plan resolves those exact fields from the journey
  // so we can fill them directly by name once the user reaches the Apply form.
  const applyPlan = useMemo(() => buildApplyPlan(journey, assessment), [journey, assessment]);
  // TfL-28: the Apply form can't be reached by a URL — the classic contactless
  // portal keeps the "selected card" in server-side session, set by a POST to
  // /Card/SelectedCard. So we enter at MyCards and reproduce TfL's own card
  // selection (see the Dashboard/MyCards steers below), which then lets Apply
  // load. primaryCardId is the CardDisplayId we already mined from statement
  // links; the select script falls back to scanning the page when it's absent.
  const claimUrl = CONTACTLESS_MYCARDS_URL;
  // TfL-32: prefer the card the user last tapped by hand (learned below) over the
  // statement-mined id, which can be stale/re-tokenised and absent from MyCards.
  const primaryCardId = useMemo(() => {
    const learned = getMeta(PREFERRED_CARD_KEY);
    if (learned && /^[0-9a-fA-F]{32}$/.test(learned)) return learned;
    return primaryCardDisplayId(getMeta(CSV_LOG_KEY));
  }, []);
  // TfL-34: the claim's own card last-4 (from the journey's masked label, e.g.
  // "Visa ending in 5006"). Used as a tiebreaker when several cards are
  // travel-ready — the select script matches it to each active card's last-4.
  const claimLast4 = useMemo(() => lastFourOf(journey.card), [journey]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(claimUrl);
  // TfL-34: a forward-only progress stepper so the user can see where the guided
  // claim flow is (TfL's own pages give no cross-step signal). Driven by the
  // nav/steer events below; bumpStage never moves it backwards.
  const [stageIdx, setStageIdx] = useState(0);
  const bumpStage = (n: number) => setStageIdx(s => (n > s ? n : s));
  // Web-history back: TfL's flow spans several pages (sign-in → cards → Apply)
  // and a wrong tap previously meant closing and reopening the whole screen.
  const [canGoBack, setCanGoBack] = useState(false);
  // TfL-22/TfL-23: after TfL's sign-in the OAuth flow returns to the
  // contactless Dashboard, not the Apply form we opened. Advance to the Apply
  // form once so login never strands the user on the dashboard. One-shot —
  // never loops.
  const advancedRef = useRef(false);
  // TfL-28: one-shot guard for the MyCards → SelectedCard → Apply card-selection
  // steer, so it fires once per session and never loops.
  const cardSelectedRef = useRef(false);
  // TfL-26: when the claim WebView reaches TfL's confirmation page we offer —
  // once — to mark the claim submitted. One-shot so a re-render can't re-prompt.
  const confirmPromptedRef = useRef(false);
  // TfL-34: one-shot guard so the Apply form auto-fills exactly once.
  const autoFilledRef = useRef(false);

  // The Apply form is the only page with the mode/station dropdowns. On every
  // other page (sign-in, card list) fall back to the keyword fill.
  const onApplyPage = /ServiceDelayRefunds\/Apply/i.test(currentUrl);

  // TfL-20: the claim WebView records the page's own outbound traffic
  // (fetch/XHR/form/beacon) to the audit Log, so filing one real claim here
  // reveals the claim endpoint + payload. Capture only — logging must never
  // be able to break the user's claim.
  const recordAudit = (tag: string, detail?: string) => {
    try {
      setMeta(AUDIT_LOG_KEY, appendAudit(getMeta(AUDIT_LOG_KEY), { at: new Date().toISOString(), tag, detail }));
    } catch { /* capture only */ }
  };

  useEffect(() => { recordAudit('claim-open', claimUrl); }, []);

  // Shared by the "Mark claimed" button and the confirmation-page prompt.
  const doMarkClaimed = () => {
    markClaimed(journey.id, assessment?.refundValue ?? null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onDone(true);
  };

  // TfL-26: fired when the injected scan detects TfL's confirmation page.
  // Prompt the user to mark the claim submitted — we never mark automatically.
  const promptMarkClaimed = () => {
    if (confirmPromptedRef.current) return;
    confirmPromptedRef.current = true;
    recordAudit('claim-confirmation', 'detected TfL confirmation page');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert(
      'Claim submitted?',
      "Looks like TfL confirmed your service delay refund. Mark this claim as submitted?",
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Mark claimed', onPress: doMarkClaimed },
      ],
    );
  };

  const copy = async (f: PrefillField) => {
    await Clipboard.setStringAsync(f.value);
    setCopiedKey(f.key);
    setTimeout(() => setCopiedKey(k => (k === f.key ? null : k)), 1500);
  };

  const fill = () => {
    setFillNote(null);
    // TfL-21: on the Apply form, fill the real captured field names directly so
    // the mode + station dropdowns populate. Elsewhere, the keyword heuristic.
    if (onApplyPage) {
      webRef.current?.injectJavaScript(buildDirectFillScript(applyPlan.fields));
    } else {
      webRef.current?.injectJavaScript(buildFillScript(fields));
    }
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      // TfL-20: instrumented page traffic → straight to the audit log.
      if (msg.type === 'net-capture') {
        recordAudit('net-capture', describeCapture(msg));
        // TfL-32: learn the card the user genuinely taps. TfL's own tap fires an
        // xhr POST /Card/SelectedCard; our auto-select uses fetch, so keying on
        // kind==='xhr' records the user's real choice, not our guess. Next claim
        // then auto-selects it (see primaryCardId above).
        if (msg.kind === 'xhr' && /\/Card\/SelectedCard/i.test(String(msg.url ?? ''))) {
          const learned = cardIdFromSelectBody(msg.body);
          if (learned) { setMeta(PREFERRED_CARD_KEY, learned); }
        }
        return;
      }
      // TfL-26: the scan found TfL's confirmation page — prompt (once) to mark claimed.
      if (msg.type === 'claim-confirmation') { bumpStage(5); promptMarkClaimed(); return; }
      // TfL-28: result of the MyCards card-selection steer. On success it's
      // already navigating to Apply (nothing to do). On failure, tell the user
      // to tap their card by hand so they still reach the form.
      if (msg.type === 'card-select') {
        const failDetail = `failed:${msg.reason ?? 'unknown'}${msg.status ? ` ${msg.status}` : ''}${msg.count ? ` (${msg.count})` : ''}`;
        recordAudit('card-select', msg.ok ? (msg.stage ?? 'ok') : failDetail);
        if (msg.ok) {
          // Card picked server-side — the script is navigating to the Apply form.
          bumpStage(2);
        } else {
          // TfL-31/TfL-34: with several travel-ready cards and no last-4 split we
          // can't safely guess (filing against the wrong card is worse than a
          // tap) — show Luke's exact wording and leave the user to pick.
          setFillNote(msg.reason === 'ambiguous-cards'
            ? "Unable to identify the correct card, please select the right card & click 'claim for a service delay'"
            : 'Tap your card above to open the claim form.');
        }
        return;
      }
      // TfL-28 DIAG (12-Oct): one-shot probe of the real MyCards DOM so the log
      // shows whether the steer script ran and what it can see (token input,
      // scannable 32-hex id, link/button/form counts) — the warm-session steer
      // posted nothing at all, so this pins down why before the real fix.
      if (msg.type === 'card-diag') {
        let detail: string;
        if (msg.error) {
          detail = `error=${msg.error}`;
        } else {
          const scanned = msg.scannedId ? String(msg.scannedId).slice(0, 8) : 'none';
          detail = `token=${msg.hasToken} prefId=${msg.prefOk} prefInDom=${msg.prefInDom} scanned=${scanned} a=${msg.anchors} btn=${msg.buttons} form=${msg.forms}`;
          // TfL-31: the page's real form actions + card/apply links — reveals the
          // live selection endpoint now that the July /Card/SelectedCard 404s.
          if (Array.isArray(msg.formActions) && msg.formActions.length) {
            detail += `\nforms: ${msg.formActions.join(' | ')}`;
          }
          if (Array.isArray(msg.cardLinks) && msg.cardLinks.length) {
            detail += `\nlinks: ${msg.cardLinks.join(' | ')}`;
          }
        }
        recordAudit('card-diag', detail);
        return;
      }
      // TfL-21: direct-fill result from the Apply form. Report what filled,
      // name anything left for the user (unmapped station/mode + not-found
      // fields), and remind them to tick the reCAPTCHA — we never auto-solve
      // it. The schema dump goes to the audit log so one real tap gives us the
      // live widget shape if any control needs tuning (no extra build round).
      if (msg.type === 'apply-fill') {
        if (msg.schema) { recordAudit('apply-fill-schema', JSON.stringify(msg.schema)); }
        if (msg.error) { setFillNote('Fill failed — use the copy chips, then tick "I\'m not a robot".'); return; }
        const notFilled: string[] = (msg.results ?? [])
          .filter((r: { filled: boolean }) => !r.filled)
          .map((r: { name: string }) => r.name);
        const leftover = [...applyPlan.unresolved, ...notFilled];
        const base = leftover.length === 0
          ? `Filled all ${msg.total} fields — check them,`
          : `Filled ${msg.filled}/${msg.total} — enter ${leftover.join(', ')} yourself,`;
        setFillNote(`${base} then tick "I'm not a robot" and submit.`);
        // Form filled — only the reCAPTCHA + submit remain (both the user's).
        bumpStage(4);
        return;
      }
      if (msg.type === 'prefill') {
        if (msg.error) { setFillNote('Fill failed — use the copy chips.'); return; }
        // TfL-9: the script reports per-field outcomes — name exactly what
        // still needs copying instead of a vague "the rest".
        const labelByKey = new Map(fields.map(f => [f.key, f.label]));
        const missing: string[] = (msg.results ?? [])
          .filter((r: { filled: boolean }) => !r.filled)
          .map((r: { key: string }) => labelByKey.get(r.key) ?? r.key);
        setFillNote(missing.length === 0
          ? `Filled all ${msg.total} fields — check them before you submit.`
          : `Filled ${msg.filled}/${msg.total} — copy ${missing.join(', ')} from the chips.`);
      }
    } catch { /* not ours */ }
  };

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={() => onDone(false)} hitSlop={12}>
          <Text style={styles.back}>✕</Text>
        </Pressable>
        <Pressable onPress={() => webRef.current?.goBack()} hitSlop={12} disabled={!canGoBack}>
          <Text style={[styles.back, !canGoBack && styles.backDisabled]}>‹ Back</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>File claim on tfl.gov.uk</Text>
        <Pressable style={styles.claimedButton} onPress={doMarkClaimed}>
          <Text style={styles.claimedButtonText}>Mark claimed</Text>
        </Pressable>
      </View>

      <View style={styles.progressRow}>
        {STAGES.map((label, i) => {
          const done = i < stageIdx;
          const active = i === stageIdx;
          return (
            <View key={label} style={styles.progressStep}>
              <View style={[styles.progressDot, done && styles.progressDotDone, active && styles.progressDotActive]}>
                <Text style={[styles.progressDotText, (done || active) && styles.progressDotTextOn]}>{done ? '✓' : String(i + 1)}</Text>
              </View>
              <Text style={[styles.progressLabel, (done || active) && styles.progressLabelOn]} numberOfLines={1}>{label}</Text>
            </View>
          );
        })}
      </View>

      <ScrollView horizontal style={styles.assistBar} contentContainerStyle={styles.assistContent} showsHorizontalScrollIndicator={false}>
        <Pressable style={styles.fillButton} onPress={fill}>
          <Text style={styles.fillButtonText}>{onApplyPage ? 'Fill form + dropdowns' : 'Fill form'}</Text>
        </Pressable>
        {fields.map(f => (
          <Pressable key={f.key} style={styles.chip} onPress={() => copy(f)}>
            <Text style={styles.chipLabel}>{copiedKey === f.key ? '✓ copied' : f.label}</Text>
            <Text style={styles.chipValue} numberOfLines={1}>{f.value}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {fillNote && <Text style={styles.fillNote}>{fillNote}</Text>}

      <WebView
        ref={webRef}
        source={{ uri: claimUrl }}
        style={styles.web}
        onMessage={onMessage}
        // TfL-20: record the page's outbound traffic (fetch/XHR/form/beacon)
        // so filing one real claim reveals its endpoint + payload for later
        // direct submission. Injected into every frame (the claim form may be
        // in an iframe); the script's window flag stops double-patching.
        // TfL-26: also scan for the claim confirmation page so we can offer to
        // mark the claim submitted. Both IIFEs end "; true;" — safe to concat.
        injectedJavaScript={buildNetCaptureScript() + '\n' + buildClaimConfirmScanScript()}
        injectedJavaScriptForMainFrameOnly={false}
        onNavigationStateChange={(nav: { url?: string; canGoBack?: boolean }) => {
          setCanGoBack(!!nav?.canGoBack);
          if (!nav?.url) return;
          const url = String(nav.url);
          // TfL-32: log a tidied URL (the B2C sign-in step's query is a giant JWT
          // that floods the Log); keep the real url for the navigation logic below.
          recordAudit('claim-nav', tidyNavLogUrl(url));
          setCurrentUrl(url);
          // TfL-29: a timed-out session bounces /MyCards → /HomePage/LoginTimedOut
          // → OAuth sign-in. That transient pre-login MyCards would otherwise burn
          // the one-shot guards below, so the card-selection steer never fires on
          // the real MyCards after login (Luke, 11-Oct: claim stranded on the card
          // list). Reset both guards on any sign-in bounce so the
          // Dashboard→MyCards→SelectedCard steer runs fresh once login completes.
          if (isLoginRedirectUrl(url)) {
            advancedRef.current = false;
            cardSelectedRef.current = false;
          }
          // TfL-30: the Dashboard→MyCards advance and the MyCards card-selection
          // steer used to fire from here. But onNavigationStateChange runs at
          // nav-commit time — before the WebView's JS context is ready — so iOS
          // silently dropped the imperative injectJavaScript (Luke's 21-Oct warm
          // trace: 'card-select-inject' logged, but the injected script's own
          // unconditional diag probe never posted → it never executed). Both
          // steers now run from onLoadEnd, which fires once the page is loaded
          // and can actually accept injected JS.
        }}
        // TfL-30: inject the steers here, not on nav-state-change — the JS
        // context is only reliably ready at load end (see note above).
        onLoadEnd={(e: { nativeEvent?: { url?: string } }) => {
          const url = String(e?.nativeEvent?.url ?? currentUrl);
          // Don't act on the sign-in bounce pages; the guard-reset above handles them.
          if (isLoginRedirectUrl(url)) return;
          // TfL-28: TfL's post-login OAuth lands on the contactless Dashboard.
          // Advance to MyCards once, where the card-selection steer then runs.
          if (!advancedRef.current && isDashboardPage(url)) {
            advancedRef.current = true;
            bumpStage(1);
            webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(CONTACTLESS_MYCARDS_URL)}; true;`);
            return;
          }
          // TfL-28: on MyCards, reproduce TfL's own card selection (POST
          // /Card/SelectedCard with the card id + anti-forgery token) so the
          // server puts a card in session, then navigate to the Apply form —
          // which otherwise returns TfL's "Sorry, there was a problem" error.
          if (!cardSelectedRef.current && isMyCardsPage(url)) {
            cardSelectedRef.current = true;
            bumpStage(1);
            // RN-side marker: guaranteed to log even if the injected script
            // never runs, so the log cleanly bisects "inject never requested"
            // from "inject ran but posted nothing" (TfL-28 DIAG, 12-Oct).
            recordAudit('card-select-inject', url);
            // TfL-34: pass the claim's last-4 so the steer can split several
            // travel-ready cards by matching it to each card's last-4.
            webRef.current?.injectJavaScript(buildCardSelectScript(primaryCardId, claimLast4));
            return;
          }
          // TfL-34: once the Apply form loads, auto-fill it (once) so the user
          // only has to tick the reCAPTCHA and submit. The manual "Fill form +
          // dropdowns" button stays as a fallback. We never auto-submit.
          if (!autoFilledRef.current && /ServiceDelayRefunds\/Apply/i.test(url)) {
            autoFilledRef.current = true;
            bumpStage(3);
            recordAudit('apply-autofill', url);
            webRef.current?.injectJavaScript(buildDirectFillScript(applyPlan.fields));
          }
        }}
        // TfL-10: shared system cookie store, so the session from signing in
        // here is reusable by the hidden journey auto-fetch WebView. Sign-in
        // still happens on TfL's pages; the cookie stays in the WebView store
        // and the app never reads or persists credentials.
        sharedCookiesEnabled={true}
        incognito={false}
      />
      <Text style={styles.footer}>
        Sign in and submit on TfL's site — this app never stores your TfL login or submits for you.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.s },
  back: { color: colors.accentBright, fontSize: 17, marginRight: spacing.m },
  backDisabled: { opacity: 0.35 },
  topTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  claimedButton: {
    backgroundColor: colors.good,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 6,
  },
  claimedButtonText: { color: '#04220F', fontSize: 13, fontWeight: '800' },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.s },
  progressStep: { flex: 1, alignItems: 'center' },
  progressDot: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
  },
  progressDotActive: { backgroundColor: colors.accentBright, borderColor: colors.accentBright },
  progressDotDone: { backgroundColor: colors.good, borderColor: colors.good },
  progressDotText: { color: colors.textDim, fontSize: 11, fontWeight: '800' },
  progressDotTextOn: { color: '#04220F' },
  progressLabel: { color: colors.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' },
  progressLabelOn: { color: colors.text, fontWeight: '700' },
  assistBar: { flexGrow: 0, marginBottom: spacing.s },
  assistContent: { alignItems: 'center', paddingRight: spacing.m },
  fillButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
    marginRight: spacing.s,
  },
  fillButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  chip: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 4,
    marginRight: spacing.s,
    maxWidth: 160,
  },
  chipLabel: { color: colors.textDim, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  chipValue: { color: colors.text, fontSize: 13, fontWeight: '600' },
  fillNote: { color: colors.textDim, fontSize: 12, marginBottom: spacing.s },
  web: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
  footer: { color: colors.textDim, fontSize: 11, lineHeight: 15, marginTop: spacing.s },
});
