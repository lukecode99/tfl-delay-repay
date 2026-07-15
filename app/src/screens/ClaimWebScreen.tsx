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
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { markClaimed } from '../claims/db';
import { buildFillScript, buildPrefill, CLAIM_APPLY_URL, PrefillField } from '../claims/prefill';
import { buildApplyPlan, buildDirectFillScript } from '../claims/apply-fill';
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

export default function ClaimWebScreen({ journey, assessment, onDone }: Props) {
  const webRef = useRef<WebView>(null);
  const fields = useMemo(() => buildPrefill(journey, assessment), [journey, assessment]);
  // TfL-21: the Apply page's dropdowns (Mode select + station typeaheads) can't
  // be driven by keyword heuristics — they set hidden numeric fields (ModeId /
  // Start-/FinishNlcId). This plan resolves those exact fields from the journey
  // so we can fill them directly by name once the user reaches the Apply form.
  const applyPlan = useMemo(() => buildApplyPlan(journey, assessment), [journey, assessment]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(CLAIM_APPLY_URL);
  // Web-history back: TfL's flow spans several pages (sign-in → cards → Apply)
  // and a wrong tap previously meant closing and reopening the whole screen.
  const [canGoBack, setCanGoBack] = useState(false);
  // TfL-22: after TfL's sign-in the OAuth flow returns to the contactless
  // Dashboard, not the card list we opened. Advance to MyCards once so login
  // never strands the user on the dashboard. One-shot — never loops.
  const advancedRef = useRef(false);

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

  useEffect(() => { recordAudit('claim-open', CLAIM_APPLY_URL); }, []);

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
      if (msg.type === 'net-capture') { recordAudit('net-capture', describeCapture(msg)); return; }
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
        <Pressable style={styles.claimedButton} onPress={() => { markClaimed(journey.id, assessment?.refundValue ?? null); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onDone(true); }}>
          <Text style={styles.claimedButtonText}>Mark claimed</Text>
        </Pressable>
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
        source={{ uri: CLAIM_APPLY_URL }}
        style={styles.web}
        onMessage={onMessage}
        // TfL-20: record the page's outbound traffic (fetch/XHR/form/beacon)
        // so filing one real claim reveals its endpoint + payload for later
        // direct submission. Injected into every frame (the claim form may be
        // in an iframe); the script's window flag stops double-patching.
        injectedJavaScript={buildNetCaptureScript()}
        injectedJavaScriptForMainFrameOnly={false}
        onNavigationStateChange={(nav: { url?: string; canGoBack?: boolean }) => {
          setCanGoBack(!!nav?.canGoBack);
          if (!nav?.url) return;
          const url = String(nav.url);
          recordAudit('claim-nav', url);
          setCurrentUrl(url);
          // TfL-22: TfL's post-login OAuth lands on the contactless Dashboard.
          // Advance to the card list once so the user reaches their cards →
          // Apply form. We never auto-select a card (wrong card = wrong claim).
          if (!advancedRef.current && /contactless\.tfl\.gov\.uk\/Dashboard/i.test(url)) {
            advancedRef.current = true;
            webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(CLAIM_APPLY_URL)}; true;`);
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
