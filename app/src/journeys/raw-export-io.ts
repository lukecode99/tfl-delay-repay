// File I/O + share-sheet wrappers for the raw-statement export (TfL-23).
// Kept separate from raw-export.ts so the pure combine step stays node-testable
// without pulling in expo-file-system / react-native.
import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import { combineRawStatements, RAW_STATEMENTS_FILE, type RawStatement } from './raw-export';

function rawPath(): string {
  const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '';
  return `${dir}${RAW_STATEMENTS_FILE}`;
}

/** Persist the raw statements captured during a refresh, for later sharing. */
export async function saveRawStatements(files: RawStatement[]): Promise<number> {
  await FileSystem.writeAsStringAsync(rawPath(), combineRawStatements(files));
  return files.length;
}

/** True once at least one refresh has saved a raw-statements file. */
export async function hasRawStatements(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(rawPath());
  return info.exists;
}

/**
 * Read back the saved combined raw-statements blob (the same text the export
 * share sheet ships) so the Stats tab can aggregate it — buses included, unlike
 * the rail-only journeys table. Returns '' if no refresh has captured one yet.
 */
export async function readRawStatements(): Promise<string> {
  const path = rawPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return '';
  return FileSystem.readAsStringAsync(path);
}

/**
 * Open the iOS share sheet with the saved raw-statements file so the user can
 * AirDrop / message / save it. Returns false if nothing has been captured yet
 * (the caller should tell the user to refresh from TfL first).
 */
export async function shareRawStatements(): Promise<boolean> {
  const path = rawPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return false;
  await Share.share({ url: path, title: 'TfL statements' });
  return true;
}
