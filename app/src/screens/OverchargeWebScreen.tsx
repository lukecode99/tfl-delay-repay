// TfL-OVERCHARGE-CLAIM: in-app browser for contactless max-fare corrections.
//
// Opens contactless.tfl.gov.uk in a WebView sharing the same signed-in session
// as the delay-repay claim flow. After OAuth login we steer to MyCards; from
// there the user navigates to their card → Incomplete journeys → selects the
// trip. When the "Complete my journey" form is detected by URL, the fill script
// is injected automatically with the exit station inferred from the journey
// pattern. On DOM mismatch (filled=0) we fall back to copy chips. The user
// always reviews and submits on TfL's own page — no unattended submission.
//
// TfL-OVERCHARGE-AUTO extensions:
//   - Auto-fill on Complete-my-journey URL detection (buildCompleteJourneyFillScript)
//   - "Fill form" manual trigger button for SPA pages where the URL doesn't change
//   - Confirmation-page banner (URL-based detection)
//   - "Share log" button to export the audit trail for form-field discovery
import * as Clipboard from 'expo-clipboard';
import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  buildCompleteJourneyFillScript,
  isCompleteJourneyConfirmPage,
  isCompleteJourneyFormPage,
} from '../claims/complete-journey-fill';
import { buildNetCaptureScript, describeCapture } from '../journeys/claim-capture';
import { appendAudit, AUDIT_LOG_KEY, formatAudit, parseAudit } from '../journeys/audit-log';
import { getMeta, setMeta } from '../journeys/db';
import type { StoredJourney } from '../journeys/db';
import type { OverchargeCandidate } from '../journeys/incomplete-fare';
import { formatDay, formatGBP } from '../format';
import { colors, spacing } from '../theme';
import { CONTACTLESS_CARDS_URL, overchargeSteerUrl } from '../claims/overcharge-steer';

interface Props {
  journey: StoredJourney;
  overcharge: OverchargeCandidate | undefined;
  onDone: () => void;
}

interface Chip {
  key: string;
  label: string;
  value: string;
}

type AutoFillState = 'idle' | 'filling' | 'filled' | 'fallback' | 'on-confirm';

function buildChips(journey: StoredJourney, overcharge: OverchargeCandidate | undefined): Chip[] {
  const chips: Chip[] = [
    { key: 'date', label: 'Journey date', value: formatDay(journey.date) },
    { key: 'entry', label: 'Entry station', value: journey.origin },
  ];
  const exitStation = overcharge?.likelyDestination ?? journey.destination;
  if (exitStation) {
    chips.push({ key: 'dest', label: 'Exit station', value: exitStation });
  }
  const charge = overcharge?.charged ?? journey.charge;
  if (charge != null) {
    chips.push({ key: 'charged', label: 'Charged', value: formatGBP(charge) });
  }
  if (journey.tapInTime) {
    chips.push({ key: 'time', label: 'Tap-in time', value: journey.tapInTime });
  }
  return chips;
}

export default function OverchargeWebScreen({ journey, overcharge, onDone }: Props) {
  const webRef = useRef<WebView>(null);
  const chips = buildChips(journey, overcharge);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [autoFill, setAutoFill] = useState<AutoFillState>('idle');
  const steerredRef = useRef(false);
  // Prevent re-injecting the fill script when navigating back to the form page.
  const fillInjectedRef = useRef(false);

  const recordAudit = (tag: string, detail?: string) => {
    try {
      setMeta(AUDIT_LOG_KEY, appendAudit(getMeta(AUDIT_LOG_KEY), { at: new Date().toISOString(), tag, detail }));
    } catch { /* capture only */ }
  };

  const copy = async (chip: Chip) => {
    await Clipboard.setStringAsync(chip.value);
    setCopiedKey(chip.key);
    setTimeout(() => setCopiedKey(k => (k === chip.key ? null : k)), 1500);
  };

  const exitStation = overcharge?.likelyDestination ?? journey.destination ?? '';

  const injectFill = () => {
    if (!exitStation) {
      setAutoFill('fallback');
      return;
    }
    setAutoFill('filling');
    fillInjectedRef.current = true;
    webRef.current?.injectJavaScript(buildCompleteJourneyFillScript({ exitStation }));
  };

  const shareLog = async () => {
    try {
      const entries = parseAudit(getMeta(AUDIT_LOG_KEY));
      await Share.share({ message: formatAudit(entries), title: 'TfL overcharge audit log' });
    } catch { /* share cancelled */ }
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'net-capture') {
        recordAudit('overcharge-capture', describeCapture(msg));
      }
      if (msg.type === 'complete-journey-fill') {
        // Schema dump → audit log for post-hoc form-field discovery.
        if (msg.schema?.length) { recordAudit('cj-fill-schema', JSON.stringify(msg.schema).slice(0, 400)); }
        if (msg.error) { setAutoFill('fallback'); return; }
        setAutoFill(msg.filled > 0 ? 'filled' : 'fallback');
      }
    } catch { /* not ours */ }
  };

  const fillNote = (() => {
    switch (autoFill) {
      case 'filling': return 'Filling form…';
      case 'filled': return `Filled exit station (${exitStation}) — check and submit.`;
      case 'fallback': return exitStation
        ? `Couldn't find the station field — use the chips above to enter "${exitStation}" manually.`
        : 'No likely destination recorded — enter the exit station manually.';
      case 'on-confirm': return null; // handled by confirm banner
      default: return exitStation
        ? `Auto-fill ready: exit station "${exitStation}" will be filled when the form opens.`
        : null;
    }
  })();

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={onDone} hitSlop={12}>
          <Text style={styles.back}>✕</Text>
        </Pressable>
        <Pressable onPress={() => webRef.current?.goBack()} hitSlop={12} disabled={!canGoBack}>
          <Text style={[styles.back, !canGoBack && styles.backDisabled]}>‹ Back</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>Correct fare · TfL contactless</Text>
        <Pressable onPress={shareLog} hitSlop={8}>
          <Text style={styles.shareLog}>Share log</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        Sign in → pick your card → Incomplete journeys → select this trip.
        {exitStation ? ' The exit station will be filled for you.' : ''}
      </Text>

      <ScrollView
        horizontal
        style={styles.assistBar}
        contentContainerStyle={styles.assistContent}
        showsHorizontalScrollIndicator={false}
      >
        {exitStation ? (
          <Pressable
            style={[styles.fillButton, autoFill === 'filling' && styles.fillButtonBusy]}
            onPress={injectFill}
            disabled={autoFill === 'filling'}
          >
            <Text style={styles.fillButtonText}>
              {autoFill === 'filling' ? 'Filling…' : autoFill === 'filled' ? 'Re-fill' : 'Fill form'}
            </Text>
          </Pressable>
        ) : null}
        {chips.map(chip => (
          <Pressable key={chip.key} style={styles.chip} onPress={() => copy(chip)}>
            <Text style={styles.chipLabel}>{copiedKey === chip.key ? '✓ copied' : chip.label}</Text>
            <Text style={styles.chipValue} numberOfLines={1}>{chip.value}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {fillNote ? <Text style={[styles.fillNote, autoFill === 'fallback' && styles.fillNoteWarn]}>{fillNote}</Text> : null}

      {autoFill === 'on-confirm' && (
        <View style={styles.confirmBanner}>
          <Text style={styles.confirmText}>Review the details below, then tap Submit on TfL's page.</Text>
        </View>
      )}

      <WebView
        ref={webRef}
        source={{ uri: CONTACTLESS_CARDS_URL }}
        style={styles.web}
        onMessage={onMessage}
        injectedJavaScript={buildNetCaptureScript()}
        injectedJavaScriptForMainFrameOnly={false}
        sharedCookiesEnabled={true}
        incognito={false}
        onNavigationStateChange={(nav: { url?: string; canGoBack?: boolean }) => {
          setCanGoBack(!!nav?.canGoBack);
          if (!nav?.url) return;
          const url = String(nav.url);
          recordAudit('overcharge-nav', url);

          // Steer from Dashboard → MyCards after OAuth login (one-shot).
          const target = overchargeSteerUrl(url);
          if (target && !steerredRef.current) {
            steerredRef.current = true;
            webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
          }

          // Auto-fill when the "Complete my journey" form is detected.
          // fillInjectedRef prevents a re-inject on back navigation to the same form.
          if (isCompleteJourneyFormPage(url) && !fillInjectedRef.current) {
            injectFill();
          }

          // Confirmation page: show the review banner.
          if (isCompleteJourneyConfirmPage(url)) {
            setAutoFill('on-confirm');
          }
        }}
      />
      <Text style={styles.footer}>
        You sign in and submit on TfL's site — this app never stores your TfL login.
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
  shareLog: { color: colors.textDim, fontSize: 13, marginLeft: spacing.s },
  hint: { color: colors.textDim, fontSize: 12, lineHeight: 16, marginBottom: spacing.s },
  assistBar: { flexGrow: 0, marginBottom: spacing.s },
  assistContent: { alignItems: 'center', paddingRight: spacing.m },
  fillButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
    marginRight: spacing.s,
  },
  fillButtonBusy: { opacity: 0.55 },
  fillButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
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
  fillNote: { color: colors.text, fontSize: 12, lineHeight: 16, marginBottom: spacing.s },
  fillNoteWarn: { color: colors.warn },
  confirmBanner: {
    backgroundColor: colors.good,
    borderRadius: 10,
    padding: spacing.m,
    marginBottom: spacing.s,
    alignItems: 'center',
  },
  confirmText: { color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  web: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
  footer: { color: colors.textDim, fontSize: 11, lineHeight: 15, marginTop: spacing.s },
});
