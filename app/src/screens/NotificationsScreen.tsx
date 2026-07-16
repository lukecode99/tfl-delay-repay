// TfL-PUSH Phase 1: Delay notifications tab.
// Recommended mode: clusters journey history into top-6 commute windows,
// infers lines, and creates one subscription per cluster.
// Custom mode: static line list + day-of-week + all-day window.
// 100% on-device — no server, no tokens, no TfL credentials.
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { clusterJourneys, type JourneyCluster } from '../notifications/cluster';
import {
  loadSubscriptions,
  saveSubscriptions,
  type DayWindow,
  type Subscription,
  type SubscriptionStore,
} from '../notifications/subscriptions';
import { registerBackgroundTask, unregisterBackgroundTask } from '../notifications/background-task';
import type { StoredJourney } from '../journeys/db';
import { colors, spacing } from '../theme';

// --- Static data ---

const ALL_LINES: { id: string; name: string }[] = [
  { id: 'bakerloo', name: 'Bakerloo' },
  { id: 'central', name: 'Central' },
  { id: 'circle', name: 'Circle' },
  { id: 'district', name: 'District' },
  { id: 'dlr', name: 'DLR' },
  { id: 'elizabeth', name: 'Elizabeth' },
  { id: 'hammersmith-city', name: 'Hammersmith & City' },
  { id: 'jubilee', name: 'Jubilee' },
  { id: 'liberty', name: 'Liberty' },
  { id: 'lioness', name: 'Lioness' },
  { id: 'metropolitan', name: 'Metropolitan' },
  { id: 'mildmay', name: 'Mildmay' },
  { id: 'northern', name: 'Northern' },
  { id: 'piccadilly', name: 'Piccadilly' },
  { id: 'suffragette', name: 'Suffragette' },
  { id: 'victoria', name: 'Victoria' },
  { id: 'waterloo-city', name: 'Waterloo & City' },
  { id: 'weaver', name: 'Weaver' },
  { id: 'windrush', name: 'Windrush' },
];

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function lineName(id: string): string {
  return ALL_LINES.find(l => l.id === id)?.name ?? id;
}

function clusterLabel(c: JourneyCluster): string {
  const day = DAY_NAMES[c.dayOfWeek] ?? '?';
  const dest = c.destination ? ` → ${c.destination}` : '';
  return `${day} ${c.avgTapIn} from ${c.origin}${dest}`;
}

function clusterLineLabel(c: JourneyCluster): string {
  if (c.lines.length === 0) return 'Line unknown — pick manually';
  return c.lines.map(lineName).join(', ');
}

function clusterToSubscription(c: JourneyCluster, idx: number): Subscription {
  const window: DayWindow = { dayOfWeek: c.dayOfWeek, windowStart: c.windowStart, windowEnd: c.windowEnd };
  return { id: `rec-${idx}`, lines: c.lines, windows: [window], enabled: true };
}

// --- Permission gate ---

async function requestPermission(): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// --- Component ---

interface Props {
  journeys: StoredJourney[];
}

export default function NotificationsScreen({ journeys }: Props) {
  const [permGranted, setPermGranted] = useState<boolean | null>(null);
  const [store, setStore] = useState<SubscriptionStore | null>(null);
  const [clusters, setClusters] = useState<JourneyCluster[]>([]);
  const [saving, setSaving] = useState(false);

  // Request permission + load store on first mount
  useEffect(() => {
    (async () => {
      const granted = await requestPermission();
      setPermGranted(granted);
      if (!granted) return;
      const s = await loadSubscriptions();
      setStore(s);
    })();
  }, []);

  // Compute clusters whenever journeys or mode changes
  useEffect(() => {
    if (store?.mode === 'recommended') {
      setClusters(clusterJourneys(journeys));
    }
  }, [journeys, store?.mode]);

  const persistStore = useCallback(async (next: SubscriptionStore) => {
    setSaving(true);
    setStore(next);
    await saveSubscriptions(next);
    // Register or unregister background task
    const hasEnabled = next.subscriptions.some(s => s.enabled);
    if (hasEnabled) {
      await registerBackgroundTask();
    } else {
      await unregisterBackgroundTask();
    }
    setSaving(false);
  }, []);

  const setMode = useCallback((mode: 'recommended' | 'custom') => {
    if (!store) return;
    const next: SubscriptionStore = { ...store, mode };
    // Auto-generate recommended subs from clusters
    if (mode === 'recommended') {
      next.subscriptions = clusters.map(clusterToSubscription);
    }
    persistStore(next);
  }, [store, clusters, persistStore]);

  const toggleSub = useCallback((id: string) => {
    if (!store) return;
    const next: SubscriptionStore = {
      ...store,
      subscriptions: store.subscriptions.map(s =>
        s.id === id ? { ...s, enabled: !s.enabled } : s,
      ),
    };
    persistStore(next);
  }, [store, persistStore]);

  const addCustomSub = useCallback((lineId: string) => {
    if (!store) return;
    if (store.subscriptions.some(s => s.lines[0] === lineId && s.lines.length === 1)) return;
    const next: SubscriptionStore = {
      ...store,
      subscriptions: [
        ...store.subscriptions,
        { id: `custom-${lineId}`, lines: [lineId], windows: [], enabled: true },
      ],
    };
    persistStore(next);
  }, [store, persistStore]);

  const removeCustomSub = useCallback((id: string) => {
    if (!store) return;
    const next: SubscriptionStore = {
      ...store,
      subscriptions: store.subscriptions.filter(s => s.id !== id),
    };
    persistStore(next);
  }, [store, persistStore]);

  // Auto-sync recommended subscriptions when clusters change
  useEffect(() => {
    if (!store || store.mode !== 'recommended' || clusters.length === 0) return;
    // Only auto-sync if subscriptions are empty (first load or reset)
    if (store.subscriptions.length > 0) return;
    const next: SubscriptionStore = {
      ...store,
      subscriptions: clusters.map(clusterToSubscription),
    };
    persistStore(next);
  }, [clusters]); // intentionally shallow — only triggers on new cluster values

  // --- Render ---

  if (permGranted === null || store === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accentBright} />
      </View>
    );
  }

  if (!permGranted) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading}>Delay notifications</Text>
        <Text style={styles.body}>
          Notification permission is required to alert you about active disruptions on your lines.
          Enable it in Settings › Notifications › TfL Delay Repay.
        </Text>
      </View>
    );
  }

  const isRecommended = store.mode === 'recommended';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: spacing.l }}>
      <Text style={styles.heading}>Delay notifications</Text>
      <Text style={styles.body}>
        Get notified when there's an active disruption on your regular lines, during your usual
        travel window.
      </Text>

      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <Pressable
          style={[styles.modeBtn, isRecommended && styles.modeBtnActive]}
          onPress={() => setMode('recommended')}
        >
          <Text style={[styles.modeBtnText, isRecommended && styles.modeBtnTextActive]}>
            Recommended
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeBtn, !isRecommended && styles.modeBtnActive]}
          onPress={() => setMode('custom')}
        >
          <Text style={[styles.modeBtnText, !isRecommended && styles.modeBtnTextActive]}>
            Custom
          </Text>
        </Pressable>
      </View>

      {saving && <ActivityIndicator color={colors.accentBright} style={{ marginVertical: spacing.s }} />}

      {/* Recommended mode */}
      {isRecommended && (
        <>
          {clusters.length === 0 ? (
            <Text style={styles.dimText}>
              No journey history yet. Import some journeys and recommended windows will appear here.
            </Text>
          ) : (
            <>
              <Text style={styles.sectionLabel}>Your commute windows</Text>
              {clusters.map((c, i) => {
                const sub = store.subscriptions.find(s => s.id === `rec-${i}`);
                return (
                  <View key={i} style={styles.card}>
                    <View style={styles.cardRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>{clusterLabel(c)}</Text>
                        <Text style={styles.cardSub}>{clusterLineLabel(c)}</Text>
                        <Text style={styles.cardSub}>
                          Window {c.windowStart}–{c.windowEnd}
                        </Text>
                      </View>
                      <Switch
                        value={sub?.enabled ?? true}
                        onValueChange={() => toggleSub(`rec-${i}`)}
                        trackColor={{ true: colors.accentBright }}
                      />
                    </View>
                    {c.lines.length === 0 && (
                      <Text style={styles.warnText}>
                        Line unknown — add this journey's line in Custom mode.
                      </Text>
                    )}
                  </View>
                );
              })}
            </>
          )}
        </>
      )}

      {/* Custom mode */}
      {!isRecommended && (
        <>
          <Text style={styles.sectionLabel}>Your subscriptions</Text>
          {store.subscriptions.length === 0 && (
            <Text style={styles.dimText}>
              No subscriptions yet. Add lines below.
            </Text>
          )}
          {store.subscriptions.map(sub => (
            <View key={sub.id} style={styles.card}>
              <View style={styles.cardRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{sub.lines.map(lineName).join(', ')}</Text>
                  <Text style={styles.cardSub}>
                    {sub.windows.length === 0 ? 'All day' : sub.windows.map(w =>
                      `${DAY_NAMES[w.dayOfWeek]} ${w.windowStart}–${w.windowEnd}`
                    ).join(', ')}
                  </Text>
                </View>
                <Switch
                  value={sub.enabled}
                  onValueChange={() => toggleSub(sub.id)}
                  trackColor={{ true: colors.accentBright }}
                />
                <Pressable onPress={() => removeCustomSub(sub.id)} style={styles.removeBtn}>
                  <Text style={styles.removeBtnText}>✕</Text>
                </Pressable>
              </View>
            </View>
          ))}

          <Text style={styles.sectionLabel}>Add a line</Text>
          <View style={styles.lineGrid}>
            {ALL_LINES.map(l => {
              const active = store.subscriptions.some(
                s => s.lines.length === 1 && s.lines[0] === l.id,
              );
              return (
                <Pressable
                  key={l.id}
                  style={[styles.lineChip, active && styles.lineChipActive]}
                  onPress={() => (active ? undefined : addCustomSub(l.id))}
                >
                  <Text style={[styles.lineChipText, active && styles.lineChipTextActive]}>
                    {l.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  heading: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: spacing.s },
  body: { color: colors.textDim, fontSize: 14.5, lineHeight: 20, marginBottom: spacing.m },
  modeRow: {
    flexDirection: 'row',
    gap: spacing.s,
    marginBottom: spacing.m,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: spacing.s,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: colors.card, borderColor: colors.accentBright },
  modeBtnText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  modeBtnTextActive: { color: colors.accentBright },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: spacing.m,
    marginBottom: spacing.s,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 2 },
  cardSub: { color: colors.textDim, fontSize: 12.5 },
  warnText: { color: colors.warn ?? '#f59e0b', fontSize: 12, marginTop: spacing.xs },
  dimText: { color: colors.textDim, fontSize: 14, marginTop: spacing.s },
  removeBtn: { paddingHorizontal: spacing.s, paddingVertical: spacing.xs },
  removeBtnText: { color: colors.textDim, fontSize: 16 },
  lineGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  lineChip: {
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.xs,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
  },
  lineChipActive: { backgroundColor: colors.accentBright, borderColor: colors.accentBright },
  lineChipText: { color: colors.textDim, fontSize: 13, fontWeight: '500' },
  lineChipTextActive: { color: '#fff', fontWeight: '700' },
});
