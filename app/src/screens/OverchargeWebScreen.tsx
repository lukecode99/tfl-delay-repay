// TfL-OVERCHARGE-CLAIM: in-app browser for contactless max-fare corrections.
//
// Opens contactless.tfl.gov.uk in a WebView sharing the same signed-in session
// cookie as the delay-repay claim flow (sharedCookiesEnabled). After the OAuth
// login the user lands on the Dashboard; we steer to MyCards so they can pick
// their card and navigate to "Incomplete journeys" / "Complete my journey" for
// the trip that was max-fared. Copy chips let them paste the journey date,
// entry station and charge into the form. The user submits themselves.
import * as Clipboard from 'expo-clipboard';
import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildNetCaptureScript, describeCapture } from '../journeys/claim-capture';
import { appendAudit, AUDIT_LOG_KEY } from '../journeys/audit-log';
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

function buildChips(journey: StoredJourney, overcharge: OverchargeCandidate | undefined): Chip[] {
  const chips: Chip[] = [
    { key: 'date', label: 'Journey date', value: formatDay(journey.date) },
    { key: 'entry', label: 'Entry station', value: journey.origin },
  ];
  if (journey.destination) {
    chips.push({ key: 'dest', label: 'Exit station', value: journey.destination });
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
  const steerredRef = useRef(false);

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

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'net-capture') { recordAudit('overcharge-capture', describeCapture(msg)); }
    } catch { /* not ours */ }
  };

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
      </View>

      <Text style={styles.hint}>
        Sign in → pick your card → Incomplete journeys → select this trip and correct it.
      </Text>

      <ScrollView
        horizontal
        style={styles.assistBar}
        contentContainerStyle={styles.assistContent}
        showsHorizontalScrollIndicator={false}
      >
        {chips.map(chip => (
          <Pressable key={chip.key} style={styles.chip} onPress={() => copy(chip)}>
            <Text style={styles.chipLabel}>{copiedKey === chip.key ? '✓ copied' : chip.label}</Text>
            <Text style={styles.chipValue} numberOfLines={1}>{chip.value}</Text>
          </Pressable>
        ))}
      </ScrollView>

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
          // Steer from Dashboard → MyCards after OAuth login (one-shot, same
          // pattern as ClaimWebScreen TfL-22).
          const target = overchargeSteerUrl(url);
          if (target && !steerredRef.current) {
            steerredRef.current = true;
            webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
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
  hint: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: spacing.s,
  },
  assistBar: { flexGrow: 0, marginBottom: spacing.s },
  assistContent: { alignItems: 'center', paddingRight: spacing.m },
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
  web: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
  footer: { color: colors.textDim, fontSize: 11, lineHeight: 15, marginTop: spacing.s },
});
