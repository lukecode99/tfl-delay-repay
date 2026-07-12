// TfL-18: refresh audit trail, newest first, shareable as plain text so the
// log can be pasted straight into a chat when a refresh misbehaves.
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { AUDIT_LOG_KEY, type AuditEntry, formatAudit, formatAuditLine, parseAudit } from '../journeys/audit-log';
import { getMeta } from '../journeys/db';
import { colors, spacing } from '../theme';

export default function AuditLogScreen() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  const reload = useCallback(() => {
    setEntries(parseAudit(getMeta(AUDIT_LOG_KEY)).reverse());
  }, []);
  useEffect(reload, [reload]);

  const onShare = useCallback(() => {
    // Share oldest-first — reads top-to-bottom as a transcript.
    const oldestFirst = [...entries].reverse();
    Share.share({ message: formatAudit(oldestFirst) }).catch(() => { /* user dismissed */ });
  }, [entries]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Refresh Log</Text>
      <Text style={styles.subtitle}>
        {entries.length} entries · every URL, phase change and fetch result from recent refreshes
      </Text>

      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.buttonRowItem]} onPress={onShare} disabled={!entries.length}>
          <Text style={styles.buttonText}>Share as text</Text>
        </Pressable>
        <Pressable style={[styles.buttonSecondary, styles.buttonRowItem]} onPress={reload}>
          <Text style={styles.buttonSecondaryText}>Reload</Text>
        </Pressable>
      </View>

      <FlatList
        data={entries}
        style={styles.list}
        keyExtractor={(_, i) => String(i)}
        ListEmptyComponent={<Text style={styles.empty}>Nothing logged yet — run a refresh first.</Text>}
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
  },
  buttonSecondaryText: { color: colors.accentBright, fontSize: 16, fontWeight: '700' },
  list: { flex: 1, marginTop: spacing.m },
  empty: { color: colors.textDim, fontSize: 14, marginTop: spacing.m },
  line: {
    color: colors.text,
    fontFamily: 'Menlo',
    fontSize: 11,
    paddingVertical: 2,
  },
});
