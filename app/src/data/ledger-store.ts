// TfL-LIVE: fetches the live ledger from the collector's GitHub feed,
// caches in AsyncStorage, and hot-swaps the lookup used by assessments.
// Bundled ledger.json is always the last-resort fallback — never crashes.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bundledSnapshot, bundledLookup } from '../eligibility/ledger';
import { makeSnapshotLookup } from '../eligibility/ledger-json';
import type { LedgerSnapshot } from '../eligibility/ledger-json';
import type { DisruptionLookup } from '../eligibility/engine';

const LEDGER_URL =
  'https://raw.githubusercontent.com/lukecode99/tfl-ledger/main/ledger.json';
const CACHE_KEY = 'tfl-live-ledger-v1';
const FETCH_AT_KEY = 'tfl-live-ledger-fetchedAt-v1';
const REFRESH_THROTTLE_MS = 30 * 60 * 1000; // 30 min

let currentSnapshot: LedgerSnapshot = bundledSnapshot;
let currentLookup: DisruptionLookup = bundledLookup;
let lastFetchAtMs = 0;

export function getLiveLookup(): DisruptionLookup {
  return currentLookup;
}

export function getLiveSnapshot(): LedgerSnapshot {
  return currentSnapshot;
}

function applySnapshot(snapshot: LedgerSnapshot): void {
  currentSnapshot = snapshot;
  currentLookup = makeSnapshotLookup(snapshot);
}

async function fetchAndCache(): Promise<LedgerSnapshot> {
  const r = await fetch(LEDGER_URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const snapshot = JSON.parse(text) as LedgerSnapshot;
  await AsyncStorage.multiSet([
    [CACHE_KEY, text],
    [FETCH_AT_KEY, new Date().toISOString()],
  ]);
  lastFetchAtMs = Date.now();
  return snapshot;
}

export interface LedgerInitResult {
  fromCache: boolean;
  generatedAt: string;
  dataNote: string | null;
}

export async function initLedger(): Promise<LedgerInitResult> {
  const pairs = await AsyncStorage.multiGet([CACHE_KEY, FETCH_AT_KEY]);
  const cachedJson = pairs[0][1];
  const fetchedAtStr = pairs[1][1];

  if (cachedJson) {
    try {
      applySnapshot(JSON.parse(cachedJson) as LedgerSnapshot);
    } catch {
      // corrupt cache — overwrite on next fetch
    }
  }

  try {
    const fresh = await fetchAndCache();
    applySnapshot(fresh);
    return { fromCache: false, generatedAt: fresh.generatedAt, dataNote: null };
  } catch {
    if (cachedJson && fetchedAtStr) {
      return {
        fromCache: true,
        generatedAt: currentSnapshot.generatedAt,
        dataNote: `Disruption data from ${formatAgo(fetchedAtStr)}`,
      };
    }
    return {
      fromCache: true,
      generatedAt: bundledSnapshot.generatedAt,
      dataNote: 'Using built-in disruption data (offline)',
    };
  }
}

export async function refreshLedger(): Promise<void> {
  if (Date.now() - lastFetchAtMs < REFRESH_THROTTLE_MS) return;
  try {
    applySnapshot(await fetchAndCache());
  } catch {
    // best-effort
  }
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!ms || ms < 0) return iso;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}
