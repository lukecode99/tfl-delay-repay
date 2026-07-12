// Refresh audit log (TfL-18). Pure module — node-testable.
//
// The refresh flow's failures have been invisible on device: a direct-fetch
// miss silently falls back to the steering harvest and the user just sees
// "you're already up to date". This module keeps a persistent trail of what
// the refresh actually did — every URL, phase change and harvest/CSV status —
// stored as a JSON ring buffer in the meta table (same pattern as
// autofetch's csvEndpointLog), rendered in the app's Log tab and shareable
// as plain text so it can be sent straight to a chat.
//
// Zero runtime imports: callers pass the current JSON in and persist the JSON
// that comes back. Corrupt or missing JSON never throws — the log must never
// be able to break a refresh.

/** Meta-table key the audit log is stored under. */
export const AUDIT_LOG_KEY = 'auditLog';

/** Most entries kept — a full refresh writes a few dozen, so this holds the
 * last several refreshes without bloating the meta table. */
export const AUDIT_LOG_CAP = 400;

/** One audit entry: when, what kind of event, and optional detail text. */
export type AuditEntry = { at: string; tag: string; detail?: string };

/** Parse a stored log; corrupt/missing JSON → empty list, never throws. */
export function parseAudit(logJson: string | null): AuditEntry[] {
  try {
    const entries = JSON.parse(logJson ?? '[]');
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(e => e && typeof e === 'object' && typeof e.at === 'string' && typeof e.tag === 'string')
      .map(e => (typeof e.detail === 'string' && e.detail !== '' ? { at: e.at, tag: e.tag, detail: e.detail } : { at: e.at, tag: e.tag }));
  } catch {
    return [];
  }
}

/** Append one entry to the stored log, returning the JSON to persist.
 * Tolerates corrupt existing JSON (starts fresh) and caps the length. */
export function appendAudit(logJson: string | null, entry: AuditEntry, cap = AUDIT_LOG_CAP): string {
  const log = parseAudit(logJson);
  log.push(typeof entry.detail === 'string' && entry.detail !== '' ? { at: entry.at, tag: entry.tag, detail: entry.detail } : { at: entry.at, tag: entry.tag });
  return JSON.stringify(log.slice(-cap));
}

/** Wipe the log — the JSON an empty log persists as. */
export function clearedAudit(): string {
  return '[]';
}

/** One entry as a plain-text line: `12 Jul 21:03:07  nav  https://…`.
 * The timestamp keeps date + seconds — refreshes are quick and ordering
 * within one matters more than brevity. */
export function formatAuditLine(e: AuditEntry): string {
  return `${shortTime(e.at)}  ${e.tag}${e.detail ? `  ${e.detail}` : ''}`;
}

/** The whole log as shareable text, oldest first (reads top-to-bottom). */
export function formatAudit(entries: AuditEntry[]): string {
  if (!entries.length) return 'Audit log is empty — run a refresh first.';
  return entries.map(formatAuditLine).join('\n');
}

/** `2026-07-12T21:03:07.123Z`-ish ISO → `12 Jul 21:03:07`; anything else
 * passes through untouched rather than throwing. */
function shortTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${mon} ${m[4]}`;
}
