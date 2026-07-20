// Import pipeline: file (document picker or share-sheet "Open in") → parse →
// SQLite. Both entry points funnel through importCsvText().
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { autoMatchRefunds } from '../claims/auto-match';
import { parseStatement, ParseResult } from './parse';
import { ImportSummary, insertJourneys, insertRefunds } from './db';

export interface ImportOutcome extends ImportSummary {
  parsed: ParseResult;
  fileName: string;
  filesChecked: number;       // how many statement files were processed (merged across cards)
  autoMatchedRefunds: number; // claims auto-marked paid from CSV credit rows
  refundsInserted: number;    // new refund credit rows persisted this import
}

export function importCsvText(text: string, fileName: string, period = ''): ImportOutcome {
  // Card id defaults to the statement filename (contactless exports are
  // per-card), keeping the dedupe key stable across re-imports of the
  // same statement while separating different cards.
  const card = fileName.replace(/\.csv$/i, '').trim() || 'unknown';
  const parsed = parseStatement(text, card);
  const summary = insertJourneys(parsed.journeys);
  const autoMatchedRefunds = autoMatchRefunds(parsed.refunds);
  const { inserted: refundsInserted } = insertRefunds(parsed.refunds, card, period);
  return { ...summary, parsed, fileName, filesChecked: 1, autoMatchedRefunds, refundsInserted };
}

/** In-app "Import statement" button → document picker. Returns null if cancelled. */
export async function importViaPicker(): Promise<ImportOutcome | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['text/csv', 'text/comma-separated-values', 'text/plain'],
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const text = await FileSystem.readAsStringAsync(asset.uri);
  return importCsvText(text, asset.name ?? 'statement.csv');
}

/** Share-sheet / "Open in" entry: iOS hands us a file:// URL via Linking. */
export async function importFromUrl(url: string): Promise<ImportOutcome | null> {
  if (!url.startsWith('file://')) return null;
  const text = await FileSystem.readAsStringAsync(url);
  const name = decodeURIComponent(url.split('/').pop() || 'statement.csv');
  return importCsvText(text, name);
}
