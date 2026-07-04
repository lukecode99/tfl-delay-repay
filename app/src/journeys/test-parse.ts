// Parser tests — run with:
//   node --experimental-strip-types src/journeys/test-parse.ts
import assert from 'node:assert/strict';
import { csvRows, journeyKey, parseDate, parseStatement } from './parse.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// --- csvRows -----------------------------------------------------------
{
  const rows = csvRows('a,b,"c,d"\n"say ""hi""",e\r\nf');
  ok(rows.length === 3, 'csvRows: 3 rows from mixed \\n and \\r\\n');
  ok(rows[0][2] === 'c,d', 'csvRows: quoted field keeps embedded comma');
  ok(rows[1][0] === 'say "hi"', 'csvRows: doubled quotes unescape');
}

// --- parseDate ---------------------------------------------------------
ok(parseDate('31-May-2026') === '2026-05-31', 'parseDate: 31-May-2026');
ok(parseDate('05/06/2026') === '2026-06-05', 'parseDate: 05/06/2026 is UK day-first');
ok(parseDate('2026-06-05') === '2026-06-05', 'parseDate: ISO passthrough');
ok(parseDate('not a date') === null, 'parseDate: garbage → null');

// --- parseStatement: Oyster export format ------------------------------
const OYSTER = `Date,Start Time,End Time,Journey/Action,Charge,Credit,Balance,Note
31-May-2026,08:12,08:47,Finchley Road to Bank,3.10,,12.40,
31-May-2026,17:30,,"Bank to Finchley Road",6.30,,6.10,No touch-out at exit
30-May-2026,12:01,12:20,"Bus journey, route 73",1.75,,18.70,
29-May-2026,,,Auto top-up,,20.00,16.95,
29-May-2026,09:05,09:40,"King's Cross to Heathrow Terminals 2 & 3",5.90,,16.95,
`;
{
  const r = parseStatement(OYSTER, 'oyster-123');
  ok(r.journeys.length === 3, 'oyster: 3 rail journeys parsed');
  ok(r.skipped === 2, 'oyster: bus journey + top-up skipped');
  ok(r.malformed === 0, 'oyster: no malformed rows');

  const [j1, j2, j3] = r.journeys;
  ok(j1.date === '2026-05-31' && j1.tapInTime === '08:12' && j1.tapOutTime === '08:47',
    'oyster: date + times parsed');
  ok(j1.origin === 'Finchley Road' && j1.destination === 'Bank', 'oyster: origin/destination split');
  ok(j1.charge === 3.10 && !j1.incomplete, 'oyster: charge parsed, complete journey');
  ok(j1.card === 'oyster-123', 'oyster: default card applied');

  ok(j2.incomplete && j2.tapOutTime === null, 'oyster: "No touch-out" note → incomplete, tap-out null');
  ok(j2.destination === 'Finchley Road', 'oyster: destination kept when note (not action) flags no-touch');

  ok(j3.origin === "King's Cross" && j3.destination === 'Heathrow Terminals 2 & 3',
    'oyster: quoted action with apostrophe + ampersand');
}

// --- parseStatement: contactless variant (no-touch in action text) ------
const CONTACTLESS = `Date,Journey/Action,Charge,Card
05/06/2026,Victoria to Brixton,3.10,Visa-4242
04/06/2026,Oxford Circus to [No touch-out],7.70,Visa-4242
03/06/2026,[No touch-in] to Euston,7.70,Visa-4242
`;
{
  const r = parseStatement(CONTACTLESS);
  ok(r.journeys.length === 2, 'contactless: 2 usable journeys');
  ok(r.malformed === 1, 'contactless: no-touch-IN row is malformed (unusable origin)');
  const [j1, j2] = r.journeys;
  ok(j1.card === 'Visa-4242', 'contactless: card column wins over default');
  ok(j1.tapInTime === null && j1.incomplete, 'contactless: missing start time → incomplete, no crash');
  ok(j2.destination === null && j2.incomplete, 'contactless: "[No touch-out]" destination → null + incomplete');
}

// --- header detection with preamble -------------------------------------
{
  const r = parseStatement(`TfL journey history\nStatement for May 2026\n\n${OYSTER}`, 'c');
  ok(r.journeys.length === 3, 'preamble lines before header row are ignored');
}

// --- no header at all ----------------------------------------------------
{
  const r = parseStatement('random,text\n1,2\n');
  ok(r.journeys.length === 0 && r.skipped === 0, 'no header row → empty result, no crash');
}

// --- journeyKey / dedupe --------------------------------------------------
{
  const a = parseStatement(OYSTER, 'oyster-123').journeys;
  const b = parseStatement(OYSTER, 'oyster-123').journeys;
  ok(journeyKey(a[0]) === journeyKey(b[0]), 'journeyKey: identical row → identical key');
  ok(journeyKey(a[0]) !== journeyKey(a[1]), 'journeyKey: different rows → different keys');
  const other = { ...a[0], card: 'other-card' };
  ok(journeyKey(other) !== journeyKey(a[0]), 'journeyKey: card is part of the key');
}

console.log(`\nAll ${passed} assertions passed.`);
