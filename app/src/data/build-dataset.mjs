// Regenerates stations.json and fares.json from live TfL data (TfL-2).
//   node build-dataset.mjs            # writes both files next to itself
// Run occasionally (fares change each March). ~65 polite sequential requests.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const agent = new https.Agent({ keepAlive: true });
const APP_KEY = process.env.TFL_APP_KEY || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getOnce(apiPath) {
  const sep = apiPath.includes('?') ? '&' : '?';
  const full = APP_KEY ? `${apiPath}${sep}app_key=${APP_KEY}` : apiPath;
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.tfl.gov.uk', path: full, agent, headers: { Accept: 'application/json', 'User-Agent': 'tfl-delay-repay-dataset/1.0' } }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error(`${apiPath} → 429`), { rateLimited: true }));
        if (res.statusCode !== 200) return reject(new Error(`${apiPath} → ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Anonymous access rate-limits well below the keyed 500/min — back off hard on 429.
async function get(apiPath, retries = 4) {
  for (let i = 0; ; i++) {
    try { return await getOnce(apiPath); }
    catch (e) {
      if (!e.rateLimited || i >= retries) throw e;
      const wait = 45000 * (i + 1);
      console.log(`    429 — backing off ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

// ── Stations ───────────────────────────────────────────────────────
const FARES_ONLY = process.argv.includes('--fares-only'); // reuse existing stations.json
const STATIONS_PATH = path.join(OUT_DIR, 'stations.json');

let stations;
if (FARES_ONLY) {
  stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8')).stations;
  console.log(`--fares-only: reusing stations.json (${stations.length} stations)`);
} else {
  const linesResp = await get('/Line/Mode/tube,dlr,overground,elizabeth-line/Status');
  const lines = linesResp.map(l => ({ id: l.id, name: l.name, mode: l.modeName }));
  console.log(`${lines.length} lines`);

  const byNaptan = new Map();
  for (const line of lines) {
    const stops = await get(`/Line/${line.id}/StopPoints`);
    for (const s of stops) {
      const zoneProp = (s.additionalProperties || []).find(p => p.key === 'Zone');
      // "Zone" can be "2", "2+3" (boundary station) or missing (out-of-zone, e.g. Reading)
      const zone = zoneProp?.value ?? null;
      const existing = byNaptan.get(s.naptanId);
      if (existing) {
        if (!existing.lines.includes(line.id)) existing.lines.push(line.id);
        if (!existing.zone && zone) existing.zone = zone;
      } else {
        byNaptan.set(s.naptanId, {
          id: s.naptanId,
          name: s.commonName.replace(/ (Underground|DLR|Rail|\(London\)) Station$/i, '').replace(/ Station$/i, ''),
          fullName: s.commonName,
          zone,
          lat: +s.lat.toFixed(5),
          lon: +s.lon.toFixed(5),
          lines: [line.id],
        });
      }
    }
    console.log(`  ${line.id}: total ${byNaptan.size}`);
    await sleep(250); // polite pacing, well under 500 req/min
  }
  stations = [...byNaptan.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(STATIONS_PATH, JSON.stringify({ generated: new Date().toISOString(), lines, stations }, null, 1));
  console.log(`stations.json: ${stations.length} stations`);
}

// ── Zone-based PAYG fare matrix (peak/off-peak) ────────────────────
// The Single Fare Finder prices the ACTUAL journey between two stations, so
// representatives must sit on the same radial corridor or the route detours
// through zone 1 and poisons the fare (e.g. two arbitrary Z4 stations on
// opposite sides of London price as a Z1-crossing journey). We sample along
// the Central line (zones 1–6) and the Metropolitan line (2,4–9), pairing
// stations so the route stays within the zone range being measured.
// Same-zone fares use two DISTINCT stations in that zone on one line —
// FareTo with from==to returns nothing. Matrix is symmetric; upper triangle only.
// Stations the Single Fare Finder has no data for (verified empty from
// multiple origins) — excluded from representative pools.
const DEAD_FARE_IDS = new Set(['940GZZLUCAL']); // Chalfont & Latimer

function repsByZone(lineId) {
  const m = {};
  for (const st of stations) {
    if (!st.zone || st.zone.includes('+')) continue; // skip boundary stations
    if (DEAD_FARE_IDS.has(st.id)) continue;
    if (!st.lines.includes(lineId)) continue;
    (m[st.zone] ??= []).push(st.id);
  }
  return m;
}
// Radial corridors in preference order. Central covers Z1-6, Metropolitan
// Z1-9 (minus 3 and 8), Lioness (Euston–Watford Overground) fills Z7-8.
const CORRIDOR_LINES = ['central', 'metropolitan', 'lioness', 'weaver', 'piccadilly', 'northern', 'district', 'jubilee', 'elizabeth'];
const pools = Object.fromEntries(CORRIDOR_LINES.map(l => [l, repsByZone(l)]));

const coord = new Map(stations.map(s => [s.id, [s.lat, s.lon]]));
function nearestPair(poolA, poolB) {
  // Geographically nearest pair — keeps the priced route inside the zone
  // range instead of detouring across London between branches.
  let best = null, bd = Infinity;
  for (const i of poolA) for (const j of poolB) {
    if (i === j) continue;
    const [a, b] = coord.get(i), [c, d] = coord.get(j);
    const dd = (a - c) ** 2 + (b - d) ** 2;
    if (dd < bd) { bd = dd; best = [i, j]; }
  }
  return best;
}

function pickPair(a, b) {
  for (const line of CORRIDOR_LINES) {
    const p = pools[line];
    if (a === b) {
      if ((p[a] || []).length >= 2) return nearestPair(p[a], p[a]);
    } else if (p[a]?.length && p[b]?.length) {
      return nearestPair(p[a], p[b]);
    }
  }
  // no single line spans both zones — nearest cross-line pair as fallback
  const all = z => CORRIDOR_LINES.flatMap(l => pools[l][z] || []);
  const A = all(a), B = all(b);
  return A.length && B.length ? nearestPair(A, B) : null;
}

function extractFares(sections) {
  // Adult Pay-as-you-go singles only. CashSingle rows share the same
  // ticketsAvailable list (ticketTime "Anytime", ~£7 flat) and must be ignored.
  let peak = null, offPeak = null;
  for (const sec of sections || []) {
    for (const row of sec.rows || []) {
      if (row.passengerType !== 'Adult') continue;
      for (const t of row.ticketsAvailable || []) {
        if (t.ticketType?.type !== 'Pay as you go') continue;
        const time = (t.ticketTime?.type || '').toLowerCase();
        const cost = parseFloat(t.cost);
        if (Number.isNaN(cost)) continue;
        if (time.includes('off')) offPeak = offPeak ?? cost;
        else if (time.includes('peak')) peak = peak ?? cost;
      }
    }
  }
  return { peak, offPeak };
}

const matrix = {};
const pairsUsed = {};
for (let a = 1; a <= 9; a++) {
  for (let b = a; b <= 9; b++) {
    const pair = pickPair(a, b);
    if (!pair) {
      console.log(`  Z${a}→Z${b}: no corridor pair available — null`);
      matrix[`${a}-${b}`] = { peak: null, offPeak: null };
      continue;
    }
    const [from, to] = pair;
    try {
      const sections = await get(`/Stoppoint/${from}/FareTo/${to}`);
      const { peak, offPeak } = extractFares(sections);
      matrix[`${a}-${b}`] = { peak, offPeak };
      pairsUsed[`${a}-${b}`] = [from, to];
      console.log(`  Z${a}→Z${b}: peak £${peak} off-peak £${offPeak}`);
    } catch (e) {
      console.log(`  Z${a}→Z${b}: FAILED ${e.message}`);
      matrix[`${a}-${b}`] = { peak: null, offPeak: null };
    }
    await sleep(1500); // anonymous access throttles hard — go slow
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'fares.json'), JSON.stringify({
  generated: new Date().toISOString(),
  note: 'Adult PAYG single fares via TfL Single Fare Finder, sampled along radial corridors (Central line Z1-6, Metropolitan Z7-9) so the priced route stays within the zone range. Key "a-b" = zone range travelled; symmetric. Peak: 06:30-09:30 & 16:00-19:00 Mon-Fri.',
  pairsUsed,
  matrix,
}, null, 1));
console.log('fares.json written');
