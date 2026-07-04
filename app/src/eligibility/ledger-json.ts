// DisruptionLookup over the bundled ledger snapshot (app/src/data/ledger.json,
// produced by collector/export-ledger.mjs). Pure module — the snapshot is
// injected so node tests run without JSON-module support; ledger.ts binds the
// bundled file for the app.
import type { DisruptionLookup, LedgerEvidence } from './engine';

export interface CoverageRange {
  from: string; // ISO UTC
  to: string;
  polls: number;
}

export interface DisruptionSpan {
  line: string;
  lineName: string;
  from: string; // first poll that saw this status
  to: string; // last poll that saw it
  severity: number;
  description: string;
  reason: string | null;
}

export interface LedgerSnapshot {
  generatedAt: string;
  sinceISO: string;
  coverage: CoverageRange[];
  spans: DisruptionSpan[];
}

const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string) =>
  aFrom <= bTo && aTo >= bFrom;

export function makeSnapshotLookup(snapshot: LedgerSnapshot): DisruptionLookup {
  return (lines, fromISO, toISO): LedgerEvidence => {
    if (!lines.length) return { coverage: 0, statuses: [] };
    const coverage = snapshot.coverage
      .filter(r => overlaps(r.from, r.to, fromISO, toISO))
      .reduce((n, r) => n + r.polls, 0);
    const statuses = snapshot.spans
      .filter(s => lines.includes(s.line) && overlaps(s.from, s.to, fromISO, toISO))
      .map(s => ({
        // Clamp the span start into the window so the engine's "during"
        // check sees a timestamp it can reason about.
        ts: s.from >= fromISO ? s.from : fromISO,
        line: s.line,
        statusSeverity: s.severity,
        statusDescription: s.description,
        reason: s.reason,
      }))
      .sort((a, b) => a.statusSeverity - b.statusSeverity || a.ts.localeCompare(b.ts));
    return { coverage, statuses };
  };
}
