// TfL-6: guided claim filing. Opens the TfL service-delay-refund flow in a
// WebView with an assist bar: one-tap copy chips for every claim value, a
// "Fill form" button that runs the keyword-heuristic inject script, and
// "Mark claimed" for when the user has submitted on the TfL page.
//
// Deliberate (design principles): the user signs in and submits on tfl.gov.uk
// themselves — no credential storage, no automated submission.
import * as Clipboard from 'expo-clipboard';
import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { markClaimed } from '../claims/db';
import { buildFillScript, buildPrefill, CLAIM_START_URL, PrefillField } from '../claims/prefill';
import type { Assessment } from '../eligibility/engine';
import type { StoredJourney } from '../journeys/db';
import { colors, spacing } from '../theme';

interface Props {
  journey: StoredJourney;
  assessment: Assessment | undefined;
  onDone: (claimed: boolean) => void;
}

export default function ClaimWebScreen({ journey, assessment, onDone }: Props) {
  const webRef = useRef<WebView>(null);
  const fields = useMemo(() => buildPrefill(journey, assessment), [journey, assessment]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fillNote, setFillNote] = useState<string | null>(null);

  const copy = async (f: PrefillField) => {
    await Clipboard.setStringAsync(f.value);
    setCopiedKey(f.key);
    setTimeout(() => setCopiedKey(k => (k === f.key ? null : k)), 1500);
  };

  const fill = () => {
    setFillNote(null);
    webRef.current?.injectJavaScript(buildFillScript(fields));
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'prefill') {
        setFillNote(msg.error
          ? 'Fill failed — use the copy chips.'
          : `Filled ${msg.filled}/${msg.total} fields — copy the rest from the chips.`);
      }
    } catch { /* not ours */ }
  };

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={() => onDone(false)} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>File claim on tfl.gov.uk</Text>
        <Pressable style={styles.claimedButton} onPress={() => { markClaimed(journey.id, assessment?.refundValue ?? null); onDone(true); }}>
          <Text style={styles.claimedButtonText}>Mark claimed</Text>
        </Pressable>
      </View>

      <ScrollView horizontal style={styles.assistBar} contentContainerStyle={styles.assistContent} showsHorizontalScrollIndicator={false}>
        <Pressable style={styles.fillButton} onPress={fill}>
          <Text style={styles.fillButtonText}>Fill form</Text>
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
        source={{ uri: CLAIM_START_URL }}
        style={styles.web}
        onMessage={onMessage}
        // Sign-in happens on TfL's pages; nothing is intercepted or stored.
        sharedCookiesEnabled={false}
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
