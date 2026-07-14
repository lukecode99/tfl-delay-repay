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
 * Undo HTML entity escaping. TfL's fetched statement text arrives with quotes
 * (and ampersands) HTML-escaped — bus rows read `&quot;Bus Journey, Route
 * 282&quot;` rather than `"Bus Journey, Route 282"`. Left as-is the export
 * isn't valid CSV (TfL-24 fix). Cheap, order-matters (&amp; last).
 */
export function unescapeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * True when a statement carries at least one data row, not just a header (or
 * nothing at all). Used to drop empty periods from the export — a card that was
 * replaced months ago still yields a header-only statement for every period,
 * which is pure clutter (TfL-24). A line counts as data if it isn't blank, a
 * `#` comment, or the `Date,…,Journey,…` header row.
 */
export function hasDataRows(text: string): boolean {
  return (text ?? '')
    .split(/\r?\n/)
    .some(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return false;
      const low = t.toLowerCase();
      if (low.startsWith('date,') && low.includes('journey')) return false; // header
      return true;
    });
}

/**
 * Concatenate per-period raw CSVs into one annotated blob. Each statement is
 * preceded by a comment banner naming its period + card so boundaries (and
 * each file's own header row) stay visible. HTML entities are unescaped so the
 * output is valid CSV, and empty (header-only) statements are dropped — the
 * banner reports how many were skipped so nothing is silently hidden. Pure: no
 * I/O, fully testable.
 */
export function combineRawStatements(files: RawStatement[]): string {
  const kept = files.filter(f => hasDataRows(f.text ?? ''));
  const skipped = files.length - kept.length;
  const header = `# TfL raw statements export — ${kept.length} file(s)` +
    (skipped > 0 ? ` (${skipped} empty period${skipped === 1 ? '' : 's'} skipped)` : '');
  const lines: string[] = [header];
  for (const f of kept) {
    lines.push(`# ===== period=${f.period ?? '?'} card=${f.card ?? '?'} =====`);
    lines.push(unescapeHtmlEntities(f.text ?? '').replace(/\s+$/, ''));
  }
  return lines.join('\n') + '\n';
}
