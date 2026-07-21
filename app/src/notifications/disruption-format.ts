// Pure formatter for disruption notification content — no React Native imports,
// node-testable. Reused by the status board (TfL-STATUS-BOARD).
export interface AlertSpan {
  lineName: string;
  description: string;
  from: string; // ISO UTC — first poll that saw this status
  reason: string | null;
}

export interface AlertContent {
  title: string;
  body: string;
}

function londonHHMM(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

function londonDow(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
  }).format(ms);
}

/** Human-readable elapsed time for notification body. */
export function formatElapsed(startMs: number, nowMs: number): string {
  const totalMin = Math.floor((nowMs - startMs) / 60_000);
  if (totalMin < 60) return `${totalMin} min ago`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h ago` : `${h} h ${m} min ago`;
}

/**
 * Builds notification title + body for a disruption span.
 *
 * Title: "{lineName} line: {description}"
 * Body:  "Started HH:MM (elapsed) — reason. Journeys during this disruption
 *          may qualify for Delay Repay."
 * If span is >24 h old, start time becomes "since ddd HH:MM".
 */
export function formatDisruptionAlert(span: AlertSpan, now: Date): AlertContent {
  const title = `${span.lineName} line: ${span.description}`;

  const startMs = new Date(span.from).getTime();
  const nowMs = now.getTime();
  const over24h = nowMs - startMs >= 24 * 60 * 60 * 1000;

  const startLabel = over24h
    ? `since ${londonDow(startMs)} ${londonHHMM(startMs)}`
    : londonHHMM(startMs);
  const elapsed = formatElapsed(startMs, nowMs);
  const reasonPart = span.reason ? ` — ${span.reason}` : '';

  const body = `Started ${startLabel} (${elapsed})${reasonPart}. Journeys during this disruption may qualify for Delay Repay.`;

  return { title, body };
}
