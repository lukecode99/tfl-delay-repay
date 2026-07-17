// PUSH-SLOTS profile model: per-line commute windows with slot-based scheduling.
// Each PushSlotProfile represents one line the user wants alerts for, with the
// days-of-week and 30-minute departure-slot indices when they usually travel.
// Slot index math: slot 0 = 00:00–00:30, slot N = N*30min–(N+1)*30min, max 47.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StoredJourney } from '../journeys/db';

const STORAGE_KEY = 'push-slots-v1';
const PHASE1_KEY = 'tfl-push-subscriptions-v1'; // cleared on first load

export interface PushSlotProfile {
  id: string;
  line: string;        // TfL line ID (e.g. 'jubilee', 'elizabeth')
  origin: string;      // display only
  destination: string; // display only
  /** 30-min slot indices (0–47) representing the usual departure window */
  slots: number[];
  /** ISO days of week: 1=Mon … 7=Sun */
  days: number[];
  enabled: boolean;
}

// --- Line catalogue ---

export const ALL_LINES: { id: string; name: string; color: string }[] = [
  { id: 'bakerloo',         name: 'Bakerloo',          color: '#B36305' },
  { id: 'central',          name: 'Central',            color: '#E32017' },
  { id: 'circle',           name: 'Circle',             color: '#FFD300' },
  { id: 'district',         name: 'District',           color: '#00782A' },
  { id: 'dlr',              name: 'DLR',                color: '#00A4A7' },
  { id: 'elizabeth',        name: 'Elizabeth',          color: '#6950A1' },
  { id: 'hammersmith-city', name: 'Hammersmith & City', color: '#F3A9BB' },
  { id: 'jubilee',          name: 'Jubilee',            color: '#A0A5A9' },
  { id: 'liberty',          name: 'Liberty',            color: '#5D6061' },
  { id: 'lioness',          name: 'Lioness',            color: '#FAA61A' },
  { id: 'metropolitan',     name: 'Metropolitan',       color: '#9B0056' },
  { id: 'mildmay',          name: 'Mildmay',            color: '#0077AD' },
  { id: 'northern',         name: 'Northern',           color: '#000000' },
  { id: 'piccadilly',       name: 'Piccadilly',         color: '#003688' },
  { id: 'suffragette',      name: 'Suffragette',        color: '#5BBD72' },
  { id: 'victoria',         name: 'Victoria',           color: '#0098D4' },
  { id: 'waterloo-city',    name: 'Waterloo & City',    color: '#95CDBA' },
  { id: 'weaver',           name: 'Weaver',             color: '#823A62' },
  { id: 'windrush',         name: 'Windrush',           color: '#ED1B00' },
];

export const DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function lineDisplayName(id: string): string {
  return ALL_LINES.find(l => l.id === id)?.name ?? id;
}

// --- Slot math ---

/** Minutes-since-midnight → 30-min slot index (0–47). */
export function minsToSlot(mins: number): number {
  return Math.min(47, Math.max(0, Math.floor(mins / 30)));
}

/** Current local time → slot index. */
export function nowSlot(): number {
  const d = new Date();
  return minsToSlot(d.getHours() * 60 + d.getMinutes());
}

/** Current ISO day of week (1=Mon … 7=Sun). */
export function todayDow(): number {
  const d = new Date().getDay(); // 0=Sun…6=Sat
  return d === 0 ? 7 : d;
}

/** "HH:MM" string → HH:MM string representation of a slot label. */
export function slotLabel(slot: number): string {
  const h = Math.floor((slot * 30) / 60);
  const m = (slot * 30) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Given a sorted array of slot indices, returns a range string like
 * "08:00 – 09:30" covering the first and last+1 slot.
 */
export function slotRangeLabel(slots: number[]): string {
  if (slots.length === 0) return '';
  const first = slots[0];
  const last = slots[slots.length - 1];
  return `${slotLabel(first)} – ${slotLabel(last + 1)}`;
}

/**
 * From a "HH:MM" usual-departure time, return the ±1 hour set of slot indices
 * (i.e. the 4 slots spanning usualTime−60min … usualTime+60min).
 */
export function slotsFromUsualTime(hhmm: string, rangeMins = 60): number[] {
  const [h, m] = hhmm.split(':').map(Number);
  const center = (h || 0) * 60 + (m || 0);
  const start = minsToSlot(Math.max(0, center - rangeMins));
  const end = minsToSlot(Math.min(23 * 60 + 30, center + rangeMins));
  const slots: number[] = [];
  for (let s = start; s <= end; s++) slots.push(s);
  return slots;
}

// --- Storage ---

let migrationDone = false;

export async function loadProfiles(): Promise<PushSlotProfile[]> {
  if (!migrationDone) {
    try { await AsyncStorage.removeItem(PHASE1_KEY); } catch { /* best-effort */ }
    migrationDone = true;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PushSlotProfile[]) : [];
  } catch {
    return [];
  }
}

export async function saveProfiles(profiles: PushSlotProfile[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export async function updateProfile(profile: PushSlotProfile): Promise<void> {
  const profiles = await loadProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  await saveProfiles(profiles);
}

export async function removeProfile(id: string): Promise<void> {
  const profiles = await loadProfiles();
  await saveProfiles(profiles.filter(p => p.id !== id));
}

// --- Inference from journey history ---

/**
 * Cluster journeys into candidate PushSlotProfiles. Groups by (origin, destination,
 * dayOfWeek); groups with ≥3 journeys become a profile suggestion. Line is left
 * empty — the user must pick it in the UI.
 */
export function inferProfiles(journeys: StoredJourney[]): PushSlotProfile[] {
  interface Bucket {
    origin: string; destination: string; dow: number;
    times: number[]; // minutes-since-midnight
  }
  const buckets = new Map<string, Bucket>();

  for (const j of journeys) {
    if (!j.tapInTime || !j.destination) continue;
    const [h, m] = j.tapInTime.split(':').map(Number);
    const mins = (h || 0) * 60 + (m || 0);
    const d = new Date(j.date + 'T00:00:00');
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    const key = `${j.origin}|${j.destination}|${dow}`;
    if (!buckets.has(key)) {
      buckets.set(key, { origin: j.origin, destination: j.destination, dow, times: [] });
    }
    buckets.get(key)!.times.push(mins);
  }

  const profiles: PushSlotProfile[] = [];
  for (const b of buckets.values()) {
    if (b.times.length < 3) continue;
    const avgMins = Math.round(b.times.reduce((a, x) => a + x, 0) / b.times.length);
    const hh = String(Math.floor(avgMins / 60)).padStart(2, '0');
    const mm = String(avgMins % 60).padStart(2, '0');
    profiles.push({
      id: `inferred-${b.origin}-${b.dow}`.replace(/\s+/g, '-').toLowerCase(),
      line: '',
      origin: b.origin,
      destination: b.destination,
      slots: slotsFromUsualTime(`${hh}:${mm}`),
      days: [b.dow],
      enabled: false, // user must set line before enabling
    });
  }
  return profiles.slice(0, 6);
}
