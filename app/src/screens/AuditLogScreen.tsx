// TfL-18: refresh audit trail, newest first, shareable as plain text so the
// log can be pasted straight into a chat when a refresh misbehaves.
//
// TfL-LOG-TODAY (Luke, 11-Oct): the ring buffer holds several refreshes, so an
// all-time export was too noisy to paste when debugging one stalled run. A
// Today / 3 days / All toggle (default Today) scopes both the on-screen list
// and the shared text. "3 days" catches last night's attempts next to this
// morning's.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { AUDIT_LOG_KEY, type AuditEntry, clearedAudit, formatAudit, formatAuditLine, isWithinDays, parseAudit } from '../journeys/audit-log';
import { getMeta, setMeta } from '../journeys/db';
import { colors, spacing } from '../theme';

// null = All time. The number is a window of calendar days up to today.
const RANGES: { label: string; days: number | null }[] = [
  { label: 'Today', days: 1 },
  { label: '3 days', days: 3 },
  { label: 'All time', days: null },
];

export default function AuditLogScreen() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  // Default to Today — the common case is grabbing the run that just failed.
  const [rangeDays, setRangeDays] = useState<number | null>(1);

  const reload = useCallback(() => {
    setEntries(parseAudit(getMeta(AUDIT_LOG_KEY)).reverse());
  }, []);
  useEffect(reload, [reload]);

  // Newest-first for the list; filtered to the chosen window. `now` is
  // recomputed whenever the filter or data changes, so a run crossing midnight
  // still scopes correctly on the next reload.
  const visible = useMemo(() => {
    if (rangeDays == null) return entries;
    const now = new Date();
    return entries.filter(e => isWithinDays(e.at, now, rangeDays));
  }, [entries, rangeDays]);

  const onShare = useCallback(() => {
    // Share oldest-first — reads top-to-bottom as a transcript.
    const oldestFirst = [...visible].reverse();
    Share.share({ message: formatAudit(oldestFirst) }).catch(() => { /* user dismissed */ });
  }, [visible]);

  // TfL-LOG-CLEAR (Luke, 12-Oct): wipe the whole ring buffer so the next
  // reproduction starts from an empty log — no scrolling past stale runs when
  // pasting a fresh trace. Clears everything (not just the visible window);
  // confirmed first so a mistap can't lose a run mid-debug.
  const onClear = useCallback(() => {
    Alert.alert(
      'Clear the log?',
      'This wipes every logged entry. Share the log first if you still need it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => { setMeta(AUDIT_LOG_KEY, clearedAudit()); reload(); },
        },
      ],
    );
  }, [reload]);

  const rangeLabel = RANGES.find(r => r.days === rangeDays)?.label ?? 'All time';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Refresh Log</Text>
      <Text style={styles.subtitle}>
        {visible.length} entries ({rangeLabel.toLowerCase()}) · every URL, phase change and fetch result from recent refreshes
      </Text>

      <View style={styles.segment}>
        {RANGES.map(r => {
          const active = r.days === rangeDays;
          return (
            <Pressable
              key={r.label}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              onPress={() => setRangeDays(r.days)}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{r.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.buttonRowItem]} onPress={onShare} disabled={!visible.length}>
          <Text style={styles.buttonText}>Share as text</Text>
        </Pressable>
        <Pressable style={[styles.buttonSecondary, styles.buttonRowItem]} onPress={reload}>
          <Text style={styles.buttonSecondaryText}>Reload</Text>
        </Pressable>
        <Pressable
          style={[styles.buttonDanger, styles.buttonRowItem]}
          onPress={onClear}
          disabled={!entries.length}
        >
          <Text style={styles.buttonDangerText}>Clear</Text>
        </Pressable>
      </View>

      <FlatList
        data={visible}
        style={styles.list}
        keyExtractor={(_, i) => String(i)}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {rangeDays == null ? 'Nothing logged yet — run a refresh first.' : `Nothing logged in this window — run a refresh, or widen the range.`}
          </Text>
        }
        renderItem={({ item }) => (
          <Text style={styles.line} selectable>{formatAuditLine(item)}</Text>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.xs },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: spacing.m },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 3,
    marginBottom: spacing.s,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: spacing.s,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: colors.accentBright },
  segmentText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: '#fff' },
  buttonRow: { flexDirection: 'row' },
  buttonRowItem: { flex: 1 },
  button: {
    backgroundColor: colors.accentBright,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
    marginRight: spacing.s,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  buttonSecondary: {
    backgroundColor: colors.card,
    borderColor: colors.accentBright,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
    marginRight: spacing.s,
  },
  buttonSecondaryText: { color: colors.accentBright, fontSize: 16, fontWeight: '700' },
  buttonDanger: {
    backgroundColor: colors.card,
    borderColor: colors.bad,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    alignItems: 'center',
  },
  buttonDangerText: { color: colors.bad, fontSize: 16, fontWeight: '700' },
  list: { flex: 1, marginTop: spacing.m },
  empty: { color: colors.textDim, fontSize: 14, marginTop: spacing.m },
  line: {
    color: colors.text,
    fontFamily: 'Menlo',
    fontSize: 11,
    paddingVertical: 2,
  },
});
