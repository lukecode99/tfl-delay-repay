// Raw-statement export (TfL-23). Lets the user share the *unparsed* TfL CSVs
// straight out of the app — the raw text exactly as TfL served it, including
// rows the importer skips as non-rail. That's what makes it a diagnostic tool:
// a missing-tap journey that never matched "X to Y" (so was ignored, never
// flagged incomplete) is still visible here.
//
// Pure combine step is node-testable; the file I/O + share sheet are thin
// wrappers over expo-file-system (legacy API, matching import.ts) and RN Share.
//
//   node --experimental-strip-types src/journeys/test-raw-export.ts

export const RAW_STATEMENTS_FILE = 'tfl-raw-statements.csv';

/** One fetched statement: its raw CSV text plus which period/card it came from. */
export interface RawStatement {
  period?: string; // "6|2026"
  card?: string; // card display id (32 hex)
  text: string; // the CSV exactly as downloaded
}

/**
 * Concatenate per-period raw CSVs into one annotated blob. Each statement is
 * preceded by a comment banner naming its period + card so boundaries (and
 * each file's own header row) stay visible. Empty statements are kept — a file
 * that yielded nothing is itself a clue. Pure: no I/O, fully testable.
 */
export function combineRawStatements(files: RawStatement[]): string {
  const lines: string[] = [`# TfL raw statements export — ${files.length} file(s)`];
  for (const f of files) {
    lines.push(`# ===== period=${f.period ?? '?'} card=${f.card ?? '?'} =====`);
    lines.push((f.text ?? '').replace(/\s+$/, ''));
  }
  return lines.join('\n') + '\n';
}
