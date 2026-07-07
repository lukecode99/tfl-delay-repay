// NR-1: guided rail claim filing. Opens the Avanti or Southern Delay Repay
// portal in a WebView with an assist bar — same pattern as ClaimWebScreen.tsx.
import * as Clipboard from 'expo-clipboard';
import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { claimRailJourney } from '../rail/db';
import type { RailJourney } from '../rail/store-core';
import { buildAvantiPrefill, buildAvantiFillScript, AVANTI_CLAIM_URL } from '../rail/avanti-prefill';
import { buildSouthernPrefill, buildSouthernFillScript, SOUTHERN_CLAIM_URL, GTR_CLAIM_URL } from '../rail/southern-prefill';
import type { PrefillField } from '../claims/prefill';
import { colors, spacing } from '../theme';

interface Props {
  journey: RailJourney;
  onDone: () => void;
}

function claimUrl(journey: RailJourney): string {
  if (journey.operator === 'avanti') return AVANTI_CLAIM_URL;
  if (journey.operator === 'gtr') return GTR_CLAIM_URL;
  return SOUTHERN_CLAIM_URL;
}

function buildPrefillFields(journey: RailJourney): PrefillField[] {
  const delay = journey.delayMinutes;
  if (journey.operator === 'avanti') return buildAvantiPrefill(journey, delay);
  return buildSouthernPrefill(journey, delay);
}

function buildFillScript(journey: RailJourney, fields: PrefillField[]): string {
  if (journey.operator === 'avanti') return buildAvantiFillScript(fields);
  return buildSouthernFillScript(fields);
}

export default function RailClaimWebScreen({ journey, onDone }: Props) {
  const webRef = useRef<WebView>(null);
  const fields = useMemo(() => buildPrefillFields(journey), [journey]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fillNote, setFillNote] = useState<string | null>(null);

  const copy = async (f: PrefillField) => {
    await Clipboard.setStringAsync(f.value);
    setCopiedKey(f.key);
    setTimeout(() => setCopiedKey(k => (k === f.key ? null : k)), 1500);
  };

  const fill = () => {
    setFillNote(null);
    webRef.current?.injectJavaScript(buildFillScript(journey, fields));
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'prefill') {
        if (msg.error) { setFillNote('Fill failed — use the copy chips.'); return; }
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

  const portalName = journey.operator === 'avanti' ? 'Avanti West Coast'
    : journey.operator === 'gtr' ? 'Thameslink / Great Northern'
    : 'Southern Railway';

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={onDone} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>File claim — {portalName}</Text>
        <Pressable style={styles.claimedButton} onPress={() => { claimRailJourney(journey.id); onDone(); }}>
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
        source={{ uri: claimUrl(journey) }}
        style={styles.web}
        onMessage={onMessage}
        sharedCookiesEnabled={false}
        incognito={false}
      />
      <Text style={styles.footer}>
        Sign in and submit on the operator's site — this app never stores your login or submits for you.
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
