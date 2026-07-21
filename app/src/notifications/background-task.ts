// TfL-PUSH: background fetch task that checks active disruptions and fires
// local notifications for lines the user is subscribed to.
//
// IMPORTANT: TaskManager.defineTask() must run at module evaluation time —
// before any component mounts. Import this file as a side-effect at the top
// of App.tsx so it registers unconditionally on startup.
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { getLiveSnapshot } from '../data/ledger-store';
import { loadSubscriptions, shouldNotify } from './subscriptions';
import type { DayWindow } from './subscriptions';
import { formatDisruptionAlert } from './disruption-format';

export const BACKGROUND_TASK_ID = 'tfl-delay-check';

/** Returns HH:MM for a Date object (local time). */
function nowHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Compares two HH:MM strings (lexicographic is correct for zero-padded). */
function timeInWindow(time: string, start: string, end: string): boolean {
  // Handle windows that wrap midnight
  if (start <= end) return time >= start && time <= end;
  return time >= start || time <= end;
}

function isoToLocal(isoStr: string): Date {
  return new Date(isoStr);
}

/** True if a span is active now OR started within the last 30 minutes. */
function spanIsRelevant(spanStartIso: string, spanEndIso: string, now: Date): boolean {
  const start = isoToLocal(spanStartIso);
  const end = isoToLocal(spanEndIso);
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  return start <= now && end > thirtyMinAgo;
}

TaskManager.defineTask(BACKGROUND_TASK_ID, async () => {
  try {
    const snapshot = getLiveSnapshot();
    const store = await loadSubscriptions();
    if (!store.subscriptions.length) return BackgroundFetch.BackgroundFetchResult.NoData;

    const now = new Date();
    const dowNow = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon…7=Sun
    const timeNow = nowHHMM(now);

    let fired = false;

    for (const sub of store.subscriptions) {
      if (!sub.enabled) continue;

      // Check if now falls in any of the subscription's windows
      const inWindow =
        sub.windows.length === 0 ||
        sub.windows.some(
          (w: DayWindow) => w.dayOfWeek === dowNow && timeInWindow(timeNow, w.windowStart, w.windowEnd),
        );
      if (!inWindow) continue;

      // Find active disruption spans for this subscription's lines
      const relevantSpans = snapshot.spans.filter(
        span =>
          sub.lines.includes(span.line) &&
          spanIsRelevant(span.from, span.to, now),
      );

      for (const span of relevantSpans) {
        const disruptionKey = `${span.line}:${span.from}`;
        const notify = await shouldNotify(span.line, disruptionKey);
        if (!notify) continue;

        const { title, body } = formatDisruptionAlert(span, now);
        await Notifications.scheduleNotificationAsync({
          content: {
            title,
            body,
            data: { line: span.line, spanFrom: span.from },
          },
          trigger: null, // fire immediately
        });
        fired = true;
      }
    }

    return fired
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundTask(): Promise<void> {
  const status = await BackgroundFetch.getStatusAsync();
  if (
    status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
    status === BackgroundFetch.BackgroundFetchStatus.Denied
  ) {
    return;
  }

  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK_ID);
  if (!isRegistered) {
    await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK_ID, {
      minimumInterval: 60 * 60, // 1 hour (iOS may space further)
      stopOnTerminate: false,
      startOnBoot: true,
    });
  }
}

export async function unregisterBackgroundTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK_ID);
  if (isRegistered) {
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_TASK_ID);
  }
}
