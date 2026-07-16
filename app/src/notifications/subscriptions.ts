// Persistent storage for delay-notification subscriptions and the 2-hour
// dedupe log that prevents the same disruption firing twice.
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUBS_KEY = 'tfl-push-subscriptions-v1';
const DEDUPE_KEY = 'tfl-push-dedupe-v1';
const DEDUPE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export type SubscriptionMode = 'recommended' | 'custom';

export interface DayWindow {
  /** ISO day of week: 1 = Monday … 7 = Sunday */
  dayOfWeek: number;
  /** HH:MM (inclusive) */
  windowStart: string;
  /** HH:MM (inclusive) */
  windowEnd: string;
}

export interface Subscription {
  id: string;
  /** TfL line ids (e.g. 'northern', 'jubilee') */
  lines: string[];
  /** Windows to notify; empty = all day */
  windows: DayWindow[];
  enabled: boolean;
}

export interface SubscriptionStore {
  mode: SubscriptionMode;
  subscriptions: Subscription[];
}

const DEFAULT_STORE: SubscriptionStore = { mode: 'recommended', subscriptions: [] };

export async function loadSubscriptions(): Promise<SubscriptionStore> {
  try {
    const raw = await AsyncStorage.getItem(SUBS_KEY);
    if (!raw) return DEFAULT_STORE;
    return JSON.parse(raw) as SubscriptionStore;
  } catch {
    return DEFAULT_STORE;
  }
}

export async function saveSubscriptions(store: SubscriptionStore): Promise<void> {
  await AsyncStorage.setItem(SUBS_KEY, JSON.stringify(store));
}

// --- Dedupe log ---

interface DedupeEntry {
  key: string; // `${lineId}:${disruptionId}`
  sentAt: number; // Date.now()
}

async function loadDedupe(): Promise<DedupeEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(DEDUPE_KEY);
    return raw ? (JSON.parse(raw) as DedupeEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveDedupe(entries: DedupeEntry[]): Promise<void> {
  await AsyncStorage.setItem(DEDUPE_KEY, JSON.stringify(entries));
}

/**
 * Returns true if this line+disruption combination has NOT been notified in
 * the last 2 hours (and records it if so).
 */
export async function shouldNotify(lineId: string, disruptionId: string): Promise<boolean> {
  const key = `${lineId}:${disruptionId}`;
  const now = Date.now();
  const entries = await loadDedupe();

  // Prune expired entries
  const fresh = entries.filter(e => now - e.sentAt < DEDUPE_TTL_MS);

  if (fresh.some(e => e.key === key)) {
    await saveDedupe(fresh);
    return false;
  }

  fresh.push({ key, sentAt: now });
  await saveDedupe(fresh);
  return true;
}

/** Clears the dedupe log (used in tests / manual reset). */
export async function clearDedupeLog(): Promise<void> {
  await AsyncStorage.removeItem(DEDUPE_KEY);
}
