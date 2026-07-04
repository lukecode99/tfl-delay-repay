// Claim-deadline reminder planning (TfL-7). Pure — node-testable; the caller
// supplies each journey's claimDeadline() result (keeps this module free of
// value imports, same pattern as resolve-core), and the expo-notifications
// binding lives in notify.ts.

/** What the planner needs to know about one journey. */
export interface ReminderInput {
  journeyId: number;
  date: string; // journey date, YYYY-MM-DD
  origin: string;
  destination: string | null;
  eligible: boolean;
  claimed: boolean; // any claim record, whatever its status
  refundValue: number | null;
  deadline: string; // from claimDeadline(): last day to file, YYYY-MM-DD
  daysLeft: number; // from claimDeadline(): negative = expired
}

export interface PlannedReminder {
  id: string; // stable notification identifier
  journeyId: number;
  fireDate: string; // YYYY-MM-DD (delivered at REMINDER_HOUR local)
  title: string;
  body: string;
}

/** Days before the deadline to nudge (per the card: T−5 and T−1). */
export const REMINDER_OFFSETS = [5, 1];
export const REMINDER_HOUR = 9; // local

const dayMs = 86400_000;
const shiftDate = (date: string, days: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * dayMs).toISOString().slice(0, 10);
};

/**
 * Reminders for eligible, unclaimed journeys whose window is still open.
 * Fire dates already past (before `today`) are dropped; a fire date of
 * `today` is kept — a same-day nudge still helps.
 */
export function planReminders(items: ReminderInput[], today: string): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const it of items) {
    if (!it.eligible || it.claimed || it.daysLeft < 0) continue;
    const route = `${it.origin} → ${it.destination ?? '?'}`;
    const value = it.refundValue != null ? ` (≈£${it.refundValue.toFixed(2)})` : '';
    for (const offset of REMINDER_OFFSETS) {
      const fireDate = shiftDate(it.deadline, -offset);
      if (fireDate < today) continue;
      out.push({
        id: `claim-${it.journeyId}-t${offset}`,
        journeyId: it.journeyId,
        fireDate,
        title: offset === 1 ? 'Last day tomorrow — TfL Delay Repay' : 'TfL Delay Repay deadline soon',
        body: `${route} on ${it.date}: ${offset} day${offset === 1 ? '' : 's'} left to claim${value}.`,
      });
    }
  }
  return out.sort((a, b) => a.fireDate.localeCompare(b.fireDate) || a.id.localeCompare(b.id));
}
