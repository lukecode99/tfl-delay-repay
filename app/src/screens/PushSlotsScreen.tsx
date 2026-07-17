// PUSH-SLOTS: subscription profile management screen.
// Each profile = one TfL line + usual departure window (day-of-week + 30-min
// slots) + origin/destination for display. Users add profiles manually; the
// app fires a foreground disruption check and weekly slot-start reminders.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  ALL_LINES,
  DOW_LABELS,
  loadProfiles,
  removeProfile,
  saveProfiles,
  slotsFromUsualTime,
  slotRangeLabel,
  type PushSlotProfile,
} from '../disruptions/push-slots';
import { syncSlotReminders } from '../disruptions/check';
import type { AssessmentMap } from '../eligibility/use-assessments';
import type { StoredJourney } from '../journeys/db';
import { colors, lineColors, spacing } from '../theme';

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

// --- Add profile modal ---

interface AddModalProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (profile: PushSlotProfile) => void;
}

function AddProfileModal({ visible, onClose, onAdd }: AddModalProps) {
  const [step, setStep] = useState<'line' | 'details'>('line');
  const [selectedLine, setSelectedLine] = useState('');

  const reset = () => {
    setStep('line');
    setSelectedLine('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleLinePick = (lineId: string) => {
    setSelectedLine(lineId);
    setStep('details');
    // Prompt for origin
    Alert.prompt(
      'Origin station',
      'Where do you usually board?',
      (origin?: string) => {
        if (!origin?.trim()) { reset(); onClose(); return; }
        // Prompt for destination
        Alert.prompt(
          'Destination station',
          'Where do you usually get off?',
          (destination?: string) => {
            if (!destination?.trim()) { reset(); onClose(); return; }
            // Prompt for usual departure time
            Alert.prompt(
              'Usual departure time',
              'HH:MM (e.g. 08:30)',
              (time?: string) => {
                const match = (time ?? '').match(/^(\d{1,2}):(\d{2})$/);
                if (!match) {
                  Alert.alert('Invalid time', 'Please enter a time like 08:30.');
                  reset(); onClose(); return;
                }
                const hh = match[1].padStart(2, '0');
                const mm = match[2];
                const profile: PushSlotProfile = {
                  id: `profile-${Date.now()}`,
                  line: lineId,
                  origin: origin.trim(),
                  destination: destination.trim(),
                  slots: slotsFromUsualTime(`${hh}:${mm}`),
                  days: [1, 2, 3, 4, 5], // weekdays by default
                  enabled: true,
                };
                reset();
                onAdd(profile);
              },
              'plain-text',
              '',
              'numbers-and-punctuation',
            );
          },
        );
      },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            {step === 'line' ? 'Pick a line' : 'Add details'}
          </Text>
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
                  onPress={() => handleLinePick(l.id)}
                >
                  <View style={[styles.lineColorDot, { backgroundColor: color }]} />
                  <Text style={styles.lineChipText}>{l.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// --- Main screen ---

export default function PushSlotsScreen({ onBack }: Props) {
  const [profiles, setProfiles] = useState<PushSlotProfile[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [permGranted, setPermGranted] = useState<boolean | null>(null);

  useEffect(() => {
    ensurePermission().then(setPermGranted);
    loadProfiles().then(setProfiles);
  }, []);

  const persist = useCallback(async (next: PushSlotProfile[]) => {
    setProfiles(next);
    await saveProfiles(next);
    await syncSlotReminders(next).catch(() => {});
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
      setProfiles(next);
      await syncSlotReminders(next).catch(() => {});
    },
    [profiles],
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
        {profiles.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No alert profiles yet</Text>
            <Text style={styles.emptyBody}>
              Tap "Add" to set up a line + departure window. When a disruption
              appears during your usual travel time, you'll get an immediate
              notification next time you open the app.
            </Text>
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
    marginBottom: spacing.l,
  },
  emptyAddBtn: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    paddingVertical: spacing.m,
    paddingHorizontal: spacing.l,
  },
  emptyAddBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
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
});
