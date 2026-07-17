// PUSH-SLOTS background fetch task.
// IMPORTANT: TaskManager.defineTask() must run at module evaluation time —
// before any component mounts. This file is imported as a side-effect near
// the top of App.tsx.
//
// Strategy: iOS background-fetch fires opportunistically (typically 1–4h
// intervals). At each wake we:
//   1. Schedule DATE-based local notifications for every upcoming slot in
//      the next 24h — these fire accurately at departure time regardless of
//      when the next background wake is.
//   2. Call the TfL Line Status API for any line with a slot active in the
//      next ~4 hours, and fire an immediate disruption alert if found.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import {
  lineDisplayName,
  loadProfiles,
  type PushSlotProfile,
} from './push-slots';

export const PUSH_SLOTS_TASK_ID = 'push-slots-check';
const ONESHOT_PREFIX = 'push-slot-1shot-';
const DEDUPE_PREFIX = 'tfl-disruption-seen-'; // shared with foreground check.ts
const GOOD_SERVICE_SEVERITY = 10;

// --- 24h slot reminder scheduling ---

/**
 * Schedule one DATE-based notification per (profile, upcoming day in next 24h),
 * firing at the earliest slot that hasn't already passed. Cancels stale
 * one-shots before rescheduling so the set stays current.
 *
 * Exported so PushSlotsScreen can call it immediately when profiles are saved,
 * giving accurate reminders from the first setup without waiting for a
 * background-fetch wake.
 */
export async function scheduleNext24h(profiles: PushSlotProfile[]): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const stale = scheduled.filter(n => n.identifier.startsWith(ONESHOT_PREFIX));
  await Promise.all(stale.map(n => Notifications.cancelScheduledNotificationAsync(n.identifier)));

  const now = new Date();
  const enabled = profiles.filter(p => p.enabled && p.line && p.slots.length && p.days.length);
  if (!enabled.length) return;

  const nowMins = now.getHours() * 60 + now.getMinutes();

  // Check today (dayOffset=0) and tomorrow (dayOffset=1)
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const target = new Date(now);
    target.setDate(target.getDate() + dayOffset);
    const dow = target.getDay() === 0 ? 7 : target.getDay(); // ISO 1=Mon…7=Sun
    const dateStr = target.toISOString().slice(0, 10);
    // For today: skip slots that have already started
    const cutoffMins = dayOffset === 0 ? nowMins : -1;

    for (const p of enabled) {
      if (!p.days.includes(dow)) continue;
      const firstSlot = p.slots.find(s => s * 30 > cutoffMins);
      if (firstSlot == null) continue;

      const hour = Math.floor((firstSlot * 30) / 60);
      const minute = (firstSlot * 30) % 60;
      const fireAt = new Date(target);
      fireAt.setHours(hour, minute, 0, 0);
      if (fireAt <= now) continue;

      const id = `${ONESHOT_PREFIX}${p.id}-${dateStr}-s${firstSlot}`;
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          title: 'Time to check for delays',
          body: `${lineDisplayName(p.line)} line from ${p.origin} — tap before you leave.`,
          sound: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
    }
  }
}

// --- Disruption check ---

interface TfLLineStatus {
  id: string;
  lineStatuses: {
    statusSeverity: number;
    statusSeverityDescription: string;
    reason?: string;
  }[];
}

async function bgCheckDisruptions(profiles: PushSlotProfile[]): Promise<boolean> {
  const now = new Date();
  const nowSlot = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const today = now.toISOString().slice(0, 10);

  // Profiles with a slot coming up in the next ~4 hours (8 slots)
  const relevant = profiles.filter(
    p =>
      p.enabled &&
      p.line &&
      p.days.includes(dow) &&
      p.slots.some(s => s >= nowSlot - 1 && s <= nowSlot + 8),
  );
  if (!relevant.length) return false;

  let seen: Set<string>;
  try {
    const raw = await AsyncStorage.getItem(DEDUPE_PREFIX + today);
    seen = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    seen = new Set();
  }

  let changed = false;
  let fired = false;

  const lines = [...new Set(relevant.map(p => p.line))];
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
          seen.add(key);
          changed = true;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `${lineDisplayName(line)} — ${status.statusSeverityDescription}`,
              body: status.reason ?? 'Disruption on your line. Check before you leave.',
              sound: false,
            },
            trigger: null,
          });
          fired = true;
        }
      }
    } catch {
      // best-effort
    }
  }

  if (changed) {
    try {
      await AsyncStorage.setItem(DEDUPE_PREFIX + today, JSON.stringify([...seen]));
    } catch {}
  }

  return fired;
}

// --- Task definition ---

TaskManager.defineTask(PUSH_SLOTS_TASK_ID, async () => {
  try {
    const profiles = await loadProfiles();
    const enabled = profiles.filter(p => p.enabled && p.line);
    if (!enabled.length) return BackgroundFetch.BackgroundFetchResult.NoData;

    await scheduleNext24h(profiles);
    const disrupted = await bgCheckDisruptions(enabled);

    return disrupted
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// --- Registration ---

export async function registerPushSlotsTask(): Promise<void> {
  const status = await BackgroundFetch.getStatusAsync();
  if (
    status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
    status === BackgroundFetch.BackgroundFetchStatus.Denied
  ) {
    return;
  }
  const isRegistered = await TaskManager.isTaskRegisteredAsync(PUSH_SLOTS_TASK_ID);
  if (!isRegistered) {
    await BackgroundFetch.registerTaskAsync(PUSH_SLOTS_TASK_ID, {
      minimumInterval: 60 * 60, // 1 hour minimum; iOS may space further
      stopOnTerminate: false,
      startOnBoot: true,
    });
  }
}

export async function unregisterPushSlotsTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(PUSH_SLOTS_TASK_ID);
  if (isRegistered) {
    await BackgroundFetch.unregisterTaskAsync(PUSH_SLOTS_TASK_ID);
  }
  // Also cancel any one-shot reminders so the user doesn't get stale alerts
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter(n => n.identifier.startsWith(ONESHOT_PREFIX))
      .map(n => Notifications.cancelScheduledNotificationAsync(n.identifier)),
  );
}
