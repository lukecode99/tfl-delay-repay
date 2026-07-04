// expo-notifications binding for claim-deadline reminders (TfL-7).
// planReminders (pure) decides what to schedule; this module makes it so.
import * as Notifications from 'expo-notifications';
import { PlannedReminder, REMINDER_HOUR } from './reminders';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let permission: boolean | null = null;
async function ensurePermission(): Promise<boolean> {
  if (permission !== null) return permission;
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return (permission = true);
  if (!current.canAskAgain) return (permission = false);
  const asked = await Notifications.requestPermissionsAsync();
  return (permission = asked.granted);
}

/**
 * Reconcile scheduled local notifications with the plan: cancel our stale
 * claim reminders, schedule missing ones. Identifiers are stable
 * (claim-<journeyId>-t<offset>), so re-syncing is idempotent.
 */
export async function syncClaimReminders(plan: PlannedReminder[]): Promise<void> {
  if (!(await ensurePermission())) return;
  const wanted = new Map(plan.map(p => [p.id, p]));
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (!n.identifier.startsWith('claim-')) continue; // not ours
    if (wanted.has(n.identifier)) wanted.delete(n.identifier); // already in place
    else await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const p of wanted.values()) {
    const [y, m, d] = p.fireDate.split('-').map(Number);
    const fireAt = new Date(y, m - 1, d, REMINDER_HOUR, 0, 0); // local time
    if (fireAt.getTime() <= Date.now()) continue; // 9am already passed today
    await Notifications.scheduleNotificationAsync({
      identifier: p.id,
      content: { title: p.title, body: p.body, sound: false },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
    });
  }
}
