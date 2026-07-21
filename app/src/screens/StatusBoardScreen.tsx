// TfL-STATUS-BOARD: full line status board screen.
// Data: ledger snapshot (getLiveSnapshot) + push-slot profiles for "your lines".
// Pull-to-refresh calls forceRefreshLedger() to bypass the 30-min throttle.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getLiveSnapshot, forceRefreshLedger } from '../data/ledger-store';
import { loadProfiles } from '../disruptions/push-slots';
import {
  buildStatusBoard,
  type StatusBoard,
  type StatusLineRow,
  type TimelineSeg,
} from '../disruptions/status-board-format';
import type { StoredJourney } from '../journeys/db';
import { ALL_LINES } from '../disruptions/push-slots';
import { colors, spacing } from '../theme';

interface Props {
  journeys: StoredJourney[];
  onClose: () => void;
}

function severityColor(severity: number): string {
  if (severity >= 10) return colors.good;
  if (severity >= 6) return colors.warn;
  return colors.bad;
}

function segColor(severity: number): string {
  if (severity < 0) return '#1D2440'; // no data
  if (severity >= 10) return colors.good;
  if (severity >= 6) return colors.warn;
  return colors.bad;
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function LineRow({ row }: { row: StatusLineRow }) {
  const [expanded, setExpanded] = useState(false);
  const isDisrupted = row.severity < 10;

  return (
    <View style={styles.lineCard}>
      <View style={[styles.lineBar, { backgroundColor: row.lineColor }]} />
      <Pressable style={styles.lineBody} onPress={() => isDisrupted && setExpanded(e => !e)}>
        <View style={styles.lineTop}>
          <Text style={styles.lineName}>{row.lineName}</Text>
          <Text style={[styles.sevLabel, { color: row.hasLiveData ? severityColor(row.severity) : colors.textDim }]}>
            {row.description}
          </Text>
        </View>

        {row.activeSpan && (
          <Text style={styles.since}>
            since <Text style={styles.sinceTime}>{row.activeSpan.sinceLabel}</Text>
            {' · '}{row.activeSpan.elapsedShort}
            {isDisrupted && <Text style={styles.activeTag}> ACTIVE</Text>}
          </Text>
        )}

        {expanded && row.activeSpan && (
          <View style={styles.expand}>
            {row.activeSpan.reason ? (
              <Text style={styles.expandDesc}>{row.activeSpan.reason}</Text>
            ) : null}

            {row.journeyOverlapCount > 0 && (
              <View style={styles.claimHint}>
                <Text style={styles.claimHintIcon}>£</Text>
                <Text style={styles.claimHintText}>
                  <Text style={styles.claimHintBold}>{row.journeyOverlapCount} of today{'\''}s journey{row.journeyOverlapCount === 1 ? '' : 's'}</Text>
                  {' overlap this disruption — check them in Journeys. 15+ min late = claimable.'}
                </Text>
              </View>
            )}

            <Timeline segs={row.todayTimeline} />
          </View>
        )}
      </Pressable>
      {!expanded && isDisrupted && <Text style={styles.chevron}>›</Text>}
    </View>
  );
}

function Timeline({ segs }: { segs: TimelineSeg[] }) {
  return (
    <>
      <View style={styles.timeline}>
        {segs.map((seg, i) => (
          <View
            key={i}
            style={[styles.timelineSeg, { backgroundColor: segColor(seg.severity) }]}
          />
        ))}
      </View>
      <View style={styles.timelineLabels}>
        <Text style={styles.tlLabel}>05:00</Text>
        <Text style={styles.tlLabel}>today</Text>
        <Text style={styles.tlLabel}>now</Text>
      </View>
    </>
  );
}

export default function StatusBoardScreen({ journeys, onClose }: Props) {
  const [board, setBoard] = useState<StatusBoard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const buildBoard = useCallback(() => {
    loadProfiles().then(profiles => {
      const yourLineIds = profiles.filter(p => p.enabled && p.line).map(p => p.line);
      const snapshot = getLiveSnapshot();
      const now = new Date();
      const overlaps = journeys.map(j => ({ date: j.date, tapInTime: j.tapInTime }));
      setBoard(buildStatusBoard(snapshot, ALL_LINES, yourLineIds, overlaps, now));
    });
  }, [journeys]);

  useEffect(() => { buildBoard(); }, [buildBoard]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    forceRefreshLedger().then(() => {
      buildBoard();
      setRefreshing(false);
    }).catch(() => setRefreshing(false));
  }, [buildBoard]);

  const generatedTime = board ? formatGeneratedAt(board.generatedAt) : '—';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Line status</Text>
        <View style={styles.headerRight}>
          <Text style={styles.updatedLabel}>updated {generatedTime}</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentBright}
          />
        }
      >
        {board && (
          <>
            {board.yourLines.length > 0 && (
              <>
                <Text style={styles.section}>Your lines</Text>
                {board.yourLines.map(row => <LineRow key={row.lineId} row={row} />)}
              </>
            )}

            <Text style={styles.section}>
              {board.yourLines.length > 0 ? 'All other lines' : 'All lines'}
            </Text>
            {board.otherLines.map(row => <LineRow key={row.lineId} row={row} />)}

            <Text style={styles.footer}>
              Live from your journey data collector · polls TfL every 5 min{'\n'}
              Updated {generatedTime} · pull to refresh
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.m,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  headerRight: { alignItems: 'flex-end' },
  updatedLabel: { color: colors.textDim, fontSize: 11 },
  closeBtn: {
    marginTop: spacing.xs,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.s,
  },
  closeBtnText: { color: colors.accentBright, fontSize: 13, fontWeight: '700' },
  scroll: { flex: 1 },
  section: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.m,
    marginBottom: spacing.s,
    marginLeft: spacing.xs,
  },
  lineCard: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: spacing.s,
    overflow: 'hidden',
  },
  lineBar: { width: 5 },
  lineBody: { flex: 1, padding: spacing.m - 4 },
  lineTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  lineName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  sevLabel: { fontSize: 12, fontWeight: '700' },
  since: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  sinceTime: { color: colors.text, fontWeight: '600' },
  activeTag: { color: colors.bad, fontSize: 10, fontWeight: '800' },
  chevron: { color: colors.textDim, alignSelf: 'center', paddingRight: spacing.s + 2, fontSize: 18 },
  expand: { borderTopWidth: 1, borderTopColor: colors.cardBorder, marginTop: spacing.s, paddingTop: spacing.s },
  expandDesc: { color: colors.text, fontSize: 12, lineHeight: 17, opacity: 0.85 },
  claimHint: {
    flexDirection: 'row',
    gap: spacing.s,
    backgroundColor: 'rgba(77,107,255,0.12)',
    borderColor: 'rgba(77,107,255,0.4)',
    borderWidth: 1,
    borderRadius: 9,
    padding: spacing.s + 2,
    marginTop: spacing.s,
  },
  claimHintIcon: { color: colors.accentBright, fontWeight: '800', fontSize: 13 },
  claimHintText: { flex: 1, fontSize: 11, lineHeight: 15, color: colors.text },
  claimHintBold: { color: colors.accentBright, fontWeight: '700' },
  timeline: {
    flexDirection: 'row',
    gap: 1,
    marginTop: spacing.s,
    alignItems: 'center',
  },
  timelineSeg: { flex: 1, height: 6, borderRadius: 2 },
  timelineLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  tlLabel: { color: colors.textDim, fontSize: 9 },
  footer: {
    color: colors.textDim,
    fontSize: 10,
    textAlign: 'center',
    paddingVertical: spacing.m,
    lineHeight: 15,
  },
});
