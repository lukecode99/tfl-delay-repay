// CLI for the wasDisrupted query helper (TfL-1).
//   node was-disrupted.mjs <line> <fromISO> <toISO>
//   node was-disrupted.mjs victoria 2026-07-04T08:00:00Z 2026-07-04T09:30:00Z
import { openDb, wasDisrupted } from './db.mjs';

const [line, fromISO, toISO] = process.argv.slice(2);
if (!line || !fromISO || !toISO) {
  console.error('usage: node was-disrupted.mjs <line> <fromISO> <toISO>');
  process.exit(2);
}

const db = openDb();
const result = wasDisrupted(db, line, fromISO, toISO);
db.close();
console.log(JSON.stringify(result, null, 2));
process.exit(result.disrupted ? 0 : result.coverage === 0 ? 3 : 1); // 0 disrupted, 1 clean, 3 no data
