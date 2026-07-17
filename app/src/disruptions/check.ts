// Foreground disruption checker for PUSH-SLOTS.
// Called from App.tsx on AppState 'active'. Fires an immediate local
// notification when a new disruption episode appears on a subscribed line
// during the user's usual travel window. Background-fetch counterpart lives
// in disruptions/background-task.ts and shares the same dedup store.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { loadProfiles, nowSlot, todayDow, type PushSlotProfile } from './push-slots';

const DEDUPE_PREFIX = 'tfl-disruption-seen-';
// Severity < 10 = disruption; 10 = Good Service (TfL API convention).
const GOOD_SERVICE_SEVERITY = 10;

interface TfLLineStatus {
  id: string;
  lineStatuses: {
    statusSeverity: number;
    statusSeverityDescription: string;
    reason?: string;
  }[];
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadSeen(date: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DEDUPE_PREFIX + date);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(date: string, seen: Set<string>): Promise<void> {
  await AsyncStorage.setItem(DEDUPE_PREFIX + date, JSON.stringify([...seen]));
}

export async function checkDisruptions(): Promise<void> {
  const profiles = await loadProfiles();
  const enabled = profiles.filter(p => p.enabled && p.line);
  if (enabled.length === 0) return;

  const dow = todayDow();
  const slot = nowSlot();
  const today = todayISO();
  const seen = await loadSeen(today);
  let changed = false;

  const lines = [...new Set(enabled.map(p => p.line))];
  for (const line of lines) {
    try {
      const resp = await fetch(`https://api.tfl.gov.uk/Line/${line}/Status`);
      if (!resp.ok) continue;
      const data = (await resp.json()) as TfLLineStatus[];
      for (const lineData of data) {
        for (const status of lineData.lineStatuses) {
          if (status.statusSeverity >= GOOD_SERVICE_SEVERITY) continue;
          const key = `${today}|${status.statusSeverity}:${status.statusSeverityDescription}`;
          if (seen.has(key)) continue;

          // Only fire if a profile for this line matches today's day and slot.
          const active = enabled.some(
            p =>
              p.line === line &&
              p.days.includes(dow) &&
              p.slots.some(s => Math.abs(s - slot) <= 2),
          );
          if (!active) continue;

          seen.add(key);
          changed = true;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `${lineData.id} line — ${status.statusSeverityDescription}`,
              body: status.reason ?? 'Disruption on your usual line. Tap to review.',
              sound: false,
            },
            trigger: null,
          });
        }
      }
    } catch {
      // best-effort — network failure silently dropped
    }
  }

  if (changed) await saveSeen(today, seen);
}

/**
 * Reconcile scheduled slot-start reminder notifications with the current
 * profile set. These fire at the user's usual departure time (weekly) as a
 * prompt to open the app and check for delays.
 */
export async function syncSlotReminders(profiles: PushSlotProfile[]): Promise<void> {
  const SLOT_PREFIX = 'push-slot-';
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const existing = scheduled.filter(n => n.identifier.startsWith(SLOT_PREFIX));

  // Build the desired id → schedule map
  const desired = new Map<
    string,
    { day: number; slot: number; line: string; origin: string }
  >();
  for (const p of profiles) {
    if (!p.enabled || !p.line) continue;
    for (const day of p.days) {
      for (const slot of p.slots.filter((_, i) => i % 4 === 0)) {
        // Sample one slot per hour to avoid notification flood
        const id = `${SLOT_PREFIX}${p.id}-d${day}-s${slot}`;
        desired.set(id, { day, slot, line: p.line, origin: p.origin });
      }
    }
  }

  // Cancel stale
  for (const n of existing) {
    if (!desired.has(n.identifier)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }

  // Schedule new
  const existingIds = new Set(existing.map(n => n.identifier));
  for (const [id, { day, slot, line, origin }] of desired) {
    if (existingIds.has(id)) continue;
    const hour = Math.floor((slot * 30) / 60);
    const minute = (slot * 30) % 60;
    // weekday: iOS/Android calendar trigger uses 1=Sunday … 7=Saturday
    // ISO dow: 1=Mon … 7=Sun → shift: Mon=2 … Sat=7 → Sun=1
    const weekday = day === 7 ? 1 : day + 1;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: 'Tap to check for delays',
        body: `${line} line from ${origin} — check before you leave.`,
        sound: false,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
        repeats: true,
        weekday,
        hour,
        minute,
      } as Parameters<typeof Notifications.scheduleNotificationAsync>[0]['trigger'],
    });
  }
}
