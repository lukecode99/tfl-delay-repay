// NR-1: manual rail journey entry form.
// Collects origin/destination CRS, date, scheduled/actual times, operator,
// fare — inserts into rail_journeys via addRailJourney. DR15 delay is
// computed from scheduledArrive/actualArrive if both provided.
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { addRailJourney } from '../rail/db';
import { computeDelay } from '../rail/eligibility';
import { searchStations } from '../rail/stations';
import type { RailJourney, RailOperator, TicketType } from '../rail/store-core';
import { colors, spacing } from '../theme';

interface Props {
  onBack: () => void;
  onSaved: () => void;
}

const OPERATORS: { label: string; value: RailOperator }[] = [
  { label: 'Avanti West Coast', value: 'avanti' },
  { label: 'Southern Railway', value: 'southern' },
  { label: 'Thameslink / Great Northern', value: 'gtr' },
];

function Field({ label, value, onChange, placeholder, keyboardType }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
}) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? ''}
        placeholderTextColor={colors.textDim}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="characters"
      />
    </View>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder="HH:MM"
        placeholderTextColor={colors.textDim}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
      />
    </View>
  );
}

function StationHint({ query }: { query: string }) {
  if (query.length < 2) return null;
  const hits = searchStations(query).slice(0, 3);
  if (hits.length === 0) return null;
  return (
    <View style={styles.hint}>
      {hits.map(s => (
        <Text key={s.crs} style={styles.hintText}>{s.crs} — {s.name}</Text>
      ))}
    </View>
  );
}

export default function RailJourneyEntryScreen({ onBack, onSaved }: Props) {
  const [originCrs, setOriginCrs] = useState('');
  const [destCrs, setDestCrs] = useState('');
  const [date, setDate] = useState('');
  const [schedDepart, setSchedDepart] = useState('');
  const [actualDepart, setActualDepart] = useState('');
  const [schedArrive, setSchedArrive] = useState('');
  const [actualArrive, setActualArrive] = useState('');
  const [operatorIdx, setOperatorIdx] = useState(0);
  const [ticketTypeIdx, setTicketTypeIdx] = useState(0); // 0 = single, 1 = return
  const [fare, setFare] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [saving, setSaving] = useState(false);

  const TICKET_TYPES: { label: string; value: TicketType }[] = [
    { label: 'Single', value: 'single' },
    { label: 'Return', value: 'return' },
  ];

  const save = () => {
    const origin = originCrs.trim().toUpperCase();
    const dest = destCrs.trim().toUpperCase();
    if (!origin || origin.length !== 3) { Alert.alert('Origin CRS must be 3 letters (e.g. EUS)'); return; }
    if (!dest || dest.length !== 3) { Alert.alert('Destination CRS must be 3 letters (e.g. MAN)'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) { Alert.alert('Date must be YYYY-MM-DD'); return; }
    if (!/^\d{2}:\d{2}$/.test(schedDepart.trim())) { Alert.alert('Scheduled depart must be HH:MM'); return; }

    const sd = schedDepart.trim();
    const sa = schedArrive.trim() || null;
    const aa = actualArrive.trim() || null;
    const ad = actualDepart.trim() || null;
    const delay = (sa && aa) ? computeDelay(sa, aa) : null;
    const farePounds = fare.trim() ? parseFloat(fare.trim()) : null;
    const pricePence = (farePounds != null && !isNaN(farePounds)) ? Math.round(farePounds * 100) : null;

    const journey: Omit<RailJourney, 'id'> = {
      originCrs: origin,
      destinationCrs: dest,
      departureDate: date.trim(),
      scheduledDepart: sd,
      actualDepart: ad,
      scheduledArrive: sa,
      actualArrive: aa,
      delayMinutes: delay,
      operator: OPERATORS[operatorIdx].value,
      ticketPricePence: pricePence,
      ticketType: TICKET_TYPES[ticketTypeIdx].value,
      ticketRef: ticketRef.trim() || null,
      claimDeadline: null, // computed by insertRailJourney
      claimedAt: null,
      claimStatus: 'pending',
      importedAt: new Date().toISOString(),
    };

    setSaving(true);
    const id = addRailJourney(journey);
    setSaving(false);
    if (id === null) {
      Alert.alert('Journey already exists', 'This journey is already in the list (same route, date and time).');
    } else {
      onSaved();
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: spacing.xl }}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>‹ Rail journeys</Text>
      </Pressable>
      <Text style={styles.title}>Add rail journey</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Route</Text>
        <Field label="From (CRS)" value={originCrs} onChange={setOriginCrs} placeholder="EUS" />
        <StationHint query={originCrs} />
        <Field label="To (CRS)" value={destCrs} onChange={setDestCrs} placeholder="MAN" />
        <StationHint query={destCrs} />
        <Field label="Date" value={date} onChange={setDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Times</Text>
        <TimeField label="Sched. depart" value={schedDepart} onChange={setSchedDepart} />
        <TimeField label="Actual depart" value={actualDepart} onChange={setActualDepart} />
        <TimeField label="Sched. arrive" value={schedArrive} onChange={setSchedArrive} />
        <TimeField label="Actual arrive" value={actualArrive} onChange={setActualArrive} />
        {schedArrive && actualArrive && (() => {
          const d = computeDelay(schedArrive, actualArrive);
          if (d === null) return null;
          return <Text style={styles.delayNote}>Computed delay: {d} min{d >= 15 ? ' — DR15 eligible' : ' — below DR15 threshold'}</Text>;
        })()}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Operator</Text>
        <View style={styles.operatorRow}>
          {OPERATORS.map((op, i) => (
            <Pressable
              key={op.value}
              style={[styles.operatorBtn, i === operatorIdx && styles.operatorBtnActive]}
              onPress={() => setOperatorIdx(i)}
            >
              <Text style={[styles.operatorBtnText, i === operatorIdx && styles.operatorBtnTextActive]}>
                {op.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Ticket type</Text>
        <View style={styles.operatorRow}>
          {TICKET_TYPES.map((tt, i) => (
            <Pressable
              key={tt.value}
              style={[styles.operatorBtn, i === ticketTypeIdx && styles.operatorBtnActive]}
              onPress={() => setTicketTypeIdx(i)}
            >
              <Text style={[styles.operatorBtnText, i === ticketTypeIdx && styles.operatorBtnTextActive]}>
                {tt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Fare (optional)</Text>
        <Field label="Ticket price (£)" value={fare} onChange={setFare} placeholder="0.00" keyboardType="decimal-pad" />
        <Field label="Ticket ref" value={ticketRef} onChange={setTicketRef} placeholder="e.g. X3K9P" />
      </View>

      <Pressable style={[styles.saveButton, saving && styles.saveButtonBusy]} onPress={save} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save journey'}</Text>
      </Pressable>

      <Text style={styles.crsNote}>
        CRS = 3-letter station code. Common codes: EUS (London Euston), MAN (Manchester Piccadilly),
        VIC (London Victoria), BTN (Brighton), LBG (London Bridge).
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  back: { color: colors.accentBright, fontSize: 17, marginBottom: spacing.m },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: spacing.l },
  section: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: spacing.s },
  fieldRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.s },
  fieldLabel: { color: colors.textDim, fontSize: 14, width: 130 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    paddingVertical: 4,
  },
  hint: { marginBottom: spacing.s, paddingLeft: 130 },
  hintText: { color: colors.accentBright, fontSize: 12, lineHeight: 18 },
  delayNote: { color: colors.warn, fontSize: 13, marginTop: spacing.s },
  operatorRow: { gap: spacing.s },
  operatorBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.s,
    marginBottom: 4,
  },
  operatorBtnActive: { borderColor: colors.accentBright, backgroundColor: colors.card },
  operatorBtnText: { color: colors.textDim, fontSize: 14 },
  operatorBtnTextActive: { color: colors.accentBright, fontWeight: '700' },
  saveButton: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
    marginBottom: spacing.m,
  },
  saveButtonBusy: { opacity: 0.6 },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  crsNote: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
});
