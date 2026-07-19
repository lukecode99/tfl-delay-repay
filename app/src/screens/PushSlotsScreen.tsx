// PUSH-SLOTS: subscription profile management screen.
// Each profile = one TfL line + usual departure window (day-of-week + 30-min
// slots) + origin/destination for display. Users add profiles manually or
// accept suggestions from their journey history; the app fires a foreground
// disruption check and a background task schedules accurate daily departure-
// time reminders.
//
// ALERT-ENTRY: origin/destination collected via searchable station picker (not
// free-text Alert.prompt). Time collected via 30-min bucket scroller.
// ALERT-SUGGEST: top-3 clusters from journey history shown above profiles.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  ALL_LINES,
  DOW_LABELS,
  clusterToProfile,
  loadProfiles,
  removeProfile,
  saveProfiles,
  slotsFromUsualTime,
  slotRangeLabel,
  type PushSlotProfile,
} from '../disruptions/push-slots';
import {
  registerPushSlotsTask,
  scheduleNext24h,
  unregisterPushSlotsTask,
} from '../disruptions/background-task';
import { clusterJourneys, type JourneyCluster } from '../notifications/cluster';
import type { AssessmentMap } from '../eligibility/use-assessments';
import type { StoredJourney } from '../journeys/db';
import { colors, lineColors, spacing } from '../theme';
import stationsData from '../data/stations.json';

interface StationEntry {
  id: string;
  name: string;
  fullName: string;
  lines: string[];
}

const STATION_LIST = (stationsData.stations as StationEntry[]);

// 48 half-hour labels: "00:00", "00:30", ..., "23:30"
const TIME_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
});

const DEFAULT_SLOT = 17; // 08:30

interface Props {
  journeys: StoredJourney[];
  assessments: AssessmentMap;
  onBack: () => void;
}

// --- Permission gate ---

async function ensurePermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  const { status: asked } = await Notifications.requestPermissionsAsync();
  return asked === 'granted';
}

// --- Day chip ---

function DayChip({
  dow,
  active,
  onPress,
}: {
  dow: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.dayChip, active && styles.dayChipActive]}
      onPress={onPress}
    >
      <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
        {DOW_LABELS[dow]}
      </Text>
    </Pressable>
  );
}

// --- Profile card ---

function ProfileCard({
  profile,
  onToggle,
  onRemove,
  onDaysChange,
}: {
  profile: PushSlotProfile;
  onToggle: () => void;
  onRemove: () => void;
  onDaysChange: (days: number[]) => void;
}) {
  const lineEntry = ALL_LINES.find(l => l.id === profile.line);
  const lineColor = lineColors[profile.line] ?? colors.accentBright;
  const lineText = lineEntry?.name ?? profile.line;

  const toggleDay = useCallback(
    (dow: number) => {
      const next = profile.days.includes(dow)
        ? profile.days.filter(d => d !== dow)
        : [...profile.days, dow].sort();
      onDaysChange(next);
    },
    [profile.days, onDaysChange],
  );

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.lineIndicator, { backgroundColor: lineColor }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{lineText} line</Text>
          <Text style={styles.cardSub}>
            {profile.origin} → {profile.destination}
          </Text>
          <Text style={styles.cardSub}>{slotRangeLabel(profile.slots)}</Text>
        </View>
        <Switch
          value={profile.enabled}
          onValueChange={onToggle}
          trackColor={{ true: colors.accentBright }}
          disabled={!profile.line}
        />
      </View>

      <View style={styles.dayRow}>
        {[1, 2, 3, 4, 5, 6, 7].map(d => (
          <DayChip
            key={d}
            dow={d}
            active={profile.days.includes(d)}
            onPress={() => toggleDay(d)}
          />
        ))}
      </View>

      <Pressable onPress={onRemove} style={styles.removeBtn}>
        <Text style={styles.removeBtnText}>Remove</Text>
      </Pressable>
    </View>
  );
}

// --- Station picker (ALERT-ENTRY) ---

function StationPicker({
  lineId,
  title,
  onPick,
  onBack,
}: {
  lineId: string;
  title: string;
  onPick: (name: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');

  const stations = useMemo(() => {
    const base = STATION_LIST
      .filter(s => s.lines.includes(lineId))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter(s =>
      s.name.toLowerCase().includes(q) || s.fullName.toLowerCase().includes(q),
    );
  }, [lineId, query]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.pickerNav}>
        <Pressable onPress={onBack}>
          <Text style={styles.pickerNavBtn}>‹ Back</Text>
        </Pressable>
        <Text style={styles.pickerNavTitle}>{title}</Text>
      </View>
      <TextInput
        style={styles.searchInput}
        placeholder="Search stations…"
        placeholderTextColor={colors.textDim}
        value={query}
        onChangeText={setQuery}
        autoFocus
      />
      <FlatList
        data={stations}
        keyExtractor={s => s.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable style={styles.stationRow} onPress={() => onPick(item.name)}>
            <Text style={styles.stationName}>{item.name}</Text>
            {item.fullName !== item.name && (
              <Text style={styles.stationFull}>{item.fullName}</Text>
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.pickerEmpty}>No stations found</Text>
        }
      />
    </View>
  );
}

// --- Time picker (ALERT-ENTRY) ---

function TimePicker({
  selected,
  onSelect,
  onBack,
  onConfirm,
}: {
  selected: number;
  onSelect: (slot: number) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    const idx = Math.max(0, selected - 3);
    setTimeout(() => flatRef.current?.scrollToIndex({ index: idx, animated: false }), 80);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.pickerNav}>
        <Pressable onPress={onBack}>
          <Text style={styles.pickerNavBtn}>‹ Back</Text>
        </Pressable>
        <Text style={styles.pickerNavTitle}>Usual departure time</Text>
        <Pressable onPress={onConfirm} style={styles.confirmBtn}>
          <Text style={styles.confirmBtnText}>Add →</Text>
        </Pressable>
      </View>
      <FlatList
        ref={flatRef}
        data={TIME_SLOTS}
        keyExtractor={(_, i) => String(i)}
        getItemLayout={(_, i) => ({ length: 52, offset: 52 * i, index: i })}
        renderItem={({ item, index }) => (
          <Pressable
            style={[styles.timeSlotRow, selected === index && styles.timeSlotRowSelected]}
            onPress={() => onSelect(index)}
          >
            <Text style={[styles.timeSlotText, selected === index && styles.timeSlotTextSelected]}>
              {item}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// --- Add profile modal (ALERT-ENTRY) ---

type ModalStep = 'line' | 'origin' | 'destination' | 'time';

interface AddModalProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (profile: PushSlotProfile) => void;
}

function AddProfileModal({ visible, onClose, onAdd }: AddModalProps) {
  const [step, setStep] = useState<ModalStep>('line');
  const [selectedLine, setSelectedLine] = useState('');
  const [selectedOrigin, setSelectedOrigin] = useState('');
  const [selectedDestination, setSelectedDestination] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(DEFAULT_SLOT);

  const reset = () => {
    setStep('line');
    setSelectedLine('');
    setSelectedOrigin('');
    setSelectedDestination('');
    setSelectedSlot(DEFAULT_SLOT);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleConfirm = () => {
    const h = Math.floor(selectedSlot / 2);
    const m = (selectedSlot % 2) * 30;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const profile: PushSlotProfile = {
      id: `profile-${Date.now()}`,
      line: selectedLine,
      origin: selectedOrigin,
      destination: selectedDestination,
      slots: slotsFromUsualTime(hhmm),
      days: [1, 2, 3, 4, 5],
      enabled: true,
    };
    reset();
    onAdd(profile);
  };

  const stepTitle: Record<ModalStep, string> = {
    line: 'Pick a line',
    origin: 'Origin station',
    destination: 'Destination station',
    time: 'Departure time',
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{stepTitle[step]}</Text>
          <Pressable onPress={handleClose}>
            <Text style={styles.modalClose}>Cancel</Text>
          </Pressable>
        </View>

        {step === 'line' && (
          <ScrollView contentContainerStyle={styles.lineGrid}>
            {ALL_LINES.map(l => {
              const color = lineColors[l.id] ?? colors.accentBright;
              return (
                <Pressable
                  key={l.id}
                  style={[styles.lineChip, { borderColor: color }]}
                  onPress={() => { setSelectedLine(l.id); setStep('origin'); }}
                >
                  <View style={[styles.lineColorDot, { backgroundColor: color }]} />
                  <Text style={styles.lineChipText}>{l.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {step === 'origin' && (
          <StationPicker
            lineId={selectedLine}
            title="Where do you board?"
            onPick={name => { setSelectedOrigin(name); setStep('destination'); }}
            onBack={() => setStep('line')}
          />
        )}

        {step === 'destination' && (
          <StationPicker
            lineId={selectedLine}
            title="Where do you get off?"
            onPick={name => { setSelectedDestination(name); setStep('time'); }}
            onBack={() => setStep('origin')}
          />
        )}

        {step === 'time' && (
          <TimePicker
            selected={selectedSlot}
            onSelect={setSelectedSlot}
            onBack={() => setStep('destination')}
            onConfirm={handleConfirm}
          />
        )}
      </View>
    </Modal>
  );
}

// --- Suggestion card (ALERT-SUGGEST) ---

function SuggestionCard({
  cluster,
  onAdd,
}: {
  cluster: JourneyCluster;
  onAdd: () => void;
}) {
  const lineId = cluster.lines[0] ?? '';
  const lineEntry = ALL_LINES.find(l => l.id === lineId);
  const lineColor = lineColors[lineId] ?? colors.textDim;

  return (
    <View style={styles.suggestCard}>
      <View style={{ flex: 1 }}>
        <Text style={styles.suggestRoute}>
          {cluster.origin} → {cluster.destination ?? '?'}
        </Text>
        <Text style={styles.suggestMeta}>
          {DOW_LABELS[cluster.dayOfWeek]}s · {cluster.avgTapIn}
          {lineEntry ? ` · ${lineEntry.name}` : ''}
          {' '}({cluster.count} journeys)
        </Text>
        {lineEntry && (
          <View style={[styles.lineBadge, { backgroundColor: lineColor }]}>
            <Text style={styles.lineBadgeText}>{lineEntry.name}</Text>
          </View>
        )}
      </View>
      <Pressable style={styles.suggestAddBtn} onPress={onAdd}>
        <Text style={styles.suggestAddBtnText}>+ Add</Text>
      </Pressable>
    </View>
  );
}

// --- Main screen ---

export default function PushSlotsScreen({ journeys, onBack }: Props) {
  const [profiles, setProfiles] = useState<PushSlotProfile[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [permGranted, setPermGranted] = useState<boolean | null>(null);

  useEffect(() => {
    ensurePermission().then(setPermGranted);
    loadProfiles().then(setProfiles);
  }, []);

  // ALERT-SUGGEST: top-3 clusters by frequency
  const suggestions = useMemo(
    () => clusterJourneys(journeys).slice(0, 3),
    [journeys],
  );

  const persist = useCallback(async (next: PushSlotProfile[]) => {
    setProfiles(next);
    await saveProfiles(next);
    await scheduleNext24h(next).catch(() => {});
    const anyEnabled = next.some(p => p.enabled && p.line);
    if (anyEnabled) {
      await registerPushSlotsTask().catch(() => {});
    } else {
      await unregisterPushSlotsTask().catch(() => {});
    }
  }, []);

  const handleToggle = useCallback(
    (id: string) => {
      const next = profiles.map(p =>
        p.id === id ? { ...p, enabled: !p.enabled } : p,
      );
      persist(next);
    },
    [profiles, persist],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      await removeProfile(id);
      const next = profiles.filter(p => p.id !== id);
      await persist(next);
    },
    [profiles, persist],
  );

  const handleDaysChange = useCallback(
    (id: string, days: number[]) => {
      const next = profiles.map(p => (p.id === id ? { ...p, days } : p));
      persist(next);
    },
    [profiles, persist],
  );

  const handleAdd = useCallback(
    (profile: PushSlotProfile) => {
      setShowAdd(false);
      const next = [...profiles, profile];
      persist(next);
    },
    [profiles, persist],
  );

  const handleSuggestAdd = useCallback(
    (cluster: JourneyCluster) => {
      handleAdd(clusterToProfile(cluster));
    },
    [handleAdd],
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Delay alerts</Text>
        <Pressable onPress={() => setShowAdd(true)} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+ Add</Text>
        </Pressable>
      </View>

      {permGranted === false && (
        <Text style={styles.permWarning}>
          Notification permission required. Enable in Settings › Notifications.
        </Text>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: spacing.l }}>
        {/* ALERT-SUGGEST: suggestions from journey history */}
        {suggestions.length > 0 && (
          <View style={styles.suggestSection}>
            <Text style={styles.suggestSectionTitle}>Suggested from your journeys</Text>
            {suggestions.map((s, i) => (
              <SuggestionCard key={i} cluster={s} onAdd={() => handleSuggestAdd(s)} />
            ))}
          </View>
        )}

        {profiles.length === 0 && suggestions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No alert profiles yet</Text>
            <Text style={styles.emptyBody}>
              Tap "Add" to set up a line + departure window. When a disruption
              appears during your usual travel time, you'll get an immediate
              notification next time you open the app.
            </Text>
            {journeys.length === 0 && (
              <Text style={styles.emptyHint}>
                Import your TfL journey history to see suggested alert profiles.
              </Text>
            )}
            <Pressable style={styles.emptyAddBtn} onPress={() => setShowAdd(true)}>
              <Text style={styles.emptyAddBtnText}>Set up first alert</Text>
            </Pressable>
          </View>
        ) : (
          profiles.map(p => (
            <ProfileCard
              key={p.id}
              profile={p}
              onToggle={() => handleToggle(p.id)}
              onRemove={() => handleRemove(p.id)}
              onDaysChange={days => handleDaysChange(p.id, days)}
            />
          ))
        )}
      </ScrollView>

      <AddProfileModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onAdd={handleAdd}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.m,
  },
  backBtn: { paddingRight: spacing.m },
  backBtnText: { color: colors.accentBright, fontSize: 16, fontWeight: '600' },
  title: { flex: 1, color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  addBtn: {
    backgroundColor: colors.accentBright,
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.m,
  },
  addBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  permWarning: {
    color: colors.warn,
    fontSize: 13,
    marginBottom: spacing.m,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.s, marginBottom: spacing.s },
  lineIndicator: { width: 4, borderRadius: 2, alignSelf: 'stretch', marginRight: spacing.s },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  cardSub: { color: colors.textDim, fontSize: 12.5, marginTop: 2 },
  dayRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.s },
  dayChip: {
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  dayChipActive: { backgroundColor: colors.accentBright, borderColor: colors.accentBright },
  dayChipText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  dayChipTextActive: { color: '#fff' },
  removeBtn: { alignSelf: 'flex-end', paddingVertical: spacing.xs },
  removeBtnText: { color: colors.bad, fontSize: 13, fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingTop: spacing.xl, paddingHorizontal: spacing.l },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: spacing.s },
  emptyBody: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.m,
  },
  emptyHint: {
    color: colors.textDim,
    fontSize: 13,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: spacing.m,
  },
  emptyAddBtn: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    paddingVertical: spacing.m,
    paddingHorizontal: spacing.l,
  },
  emptyAddBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  // Modal
  modalContainer: { flex: 1, backgroundColor: colors.bg, padding: spacing.l },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.l,
  },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  modalClose: { color: colors.accentBright, fontSize: 16 },
  lineGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s },
  lineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 2,
    borderRadius: 20,
    paddingVertical: spacing.s,
    paddingHorizontal: spacing.m,
    marginBottom: spacing.xs,
  },
  lineColorDot: { width: 10, height: 10, borderRadius: 5 },
  lineChipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  // Station picker
  pickerNav: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.m,
    gap: spacing.s,
  },
  pickerNavBtn: { color: colors.accentBright, fontSize: 16, fontWeight: '600', marginRight: spacing.s },
  pickerNavTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700' },
  searchInput: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
    color: colors.text,
    fontSize: 15,
    marginBottom: spacing.s,
  },
  stationRow: {
    paddingVertical: spacing.s,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.cardBorder,
  },
  stationName: { color: colors.text, fontSize: 15, fontWeight: '500' },
  stationFull: { color: colors.textDim, fontSize: 12, marginTop: 1 },
  pickerEmpty: { color: colors.textDim, textAlign: 'center', paddingTop: spacing.xl, fontSize: 14 },
  // Time picker
  confirmBtn: {
    backgroundColor: colors.accentBright,
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.m,
  },
  confirmBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  timeSlotRow: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: spacing.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.cardBorder,
  },
  timeSlotRowSelected: { backgroundColor: colors.accentBright },
  timeSlotText: { color: colors.text, fontSize: 18 },
  timeSlotTextSelected: { color: '#fff', fontWeight: '700' },
  // Suggestions
  suggestSection: { marginBottom: spacing.l },
  suggestSectionTitle: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: spacing.s,
  },
  suggestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.s,
    gap: spacing.s,
  },
  suggestRoute: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 3 },
  suggestMeta: { color: colors.textDim, fontSize: 12 },
  lineBadge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: spacing.s,
    paddingVertical: 2,
    marginTop: spacing.xs,
  },
  lineBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  suggestAddBtn: {
    backgroundColor: colors.accentBright,
    borderRadius: 8,
    paddingVertical: spacing.s,
    paddingHorizontal: spacing.m,
  },
  suggestAddBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
