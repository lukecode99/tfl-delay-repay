// TfL delay-refund claims must be made within 28 days of the journey.
export const CLAIM_WINDOW_DAYS = 28;

export interface ClaimDeadline {
  deadline: string; // YYYY-MM-DD, last day a claim can be filed
  daysLeft: number; // 0 = last day today, negative = expired
}

const dayMs = 86400_000;
const toDayMs = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `today` as YYYY-MM-DD (injected for tests; UI passes the device date). */
export function claimDeadline(journeyDate: string, today: string): ClaimDeadline {
  const deadlineMs = toDayMs(journeyDate) + CLAIM_WINDOW_DAYS * dayMs;
  return {
    deadline: toDate(deadlineMs),
    daysLeft: Math.round((deadlineMs - toDayMs(today)) / dayMs),
  };
}
