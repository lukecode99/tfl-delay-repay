// Visible-refresh state machine tests (TfL-11/12) — run with:
//   node --experimental-strip-types src/journeys/test-refresh-flow.ts
import assert from 'node:assert/strict';
import { JOURNEY_HISTORY_URL } from './autofetch.ts';
import {
  type FlowEvent,
  type FlowState,
  HISTORY_URL,
  INITIAL_FLOW,
  isLoginUrl,
  isTerminal,
  MAX_CARDS,
  MAX_STEERS,
  reduceFlow,
  statusText,
} from './refresh-flow.ts';

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const run = (events: FlowEvent[], from: FlowState = INITIAL_FLOW) => events.reduce(reduceFlow, from);

const LOGIN_URL = 'https://account.tfl.gov.uk/Login?returnUrl=x';
const DASHBOARD_URL = 'https://account.tfl.gov.uk/Dashboard';
const HOME_URL = 'https://contactless.tfl.gov.uk/HomePage';
const CARD_A = 'https://contactless.tfl.gov.uk/Card/A/History';
const CARD_B = 'https://contactless.tfl.gov.uk/Card/B/History';
const CARD_C = 'https://contactless.tfl.gov.uk/Card/C/History';

// --- URL classification ---
ok(HISTORY_URL === JOURNEY_HISTORY_URL, 'urls: steering target matches the harvest module’s history URL');
ok(isLoginUrl(LOGIN_URL) && isLoginUrl('https://contactless.tfl.gov.uk/SignIn'), 'urls: login pages recognised');
ok(!isLoginUrl(JOURNEY_HISTORY_URL) && !isLoginUrl(HOME_URL), 'urls: contactless pages are not login pages');
ok(!isLoginUrl(DASHBOARD_URL), 'urls: the signed-in My Account dashboard is NOT a login page (TfL-12)');

// --- happy path: load → harvest → import → done, narrated ---
ok(INITIAL_FLOW.phase === 'loading' && statusText(INITIAL_FLOW).includes('Loading'), 'flow starts loading, status says so');
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  ok(s.phase === 'harvesting' && statusText(s).includes('journey history'), 'history page loaded → harvesting, status narrates');
  s = reduceFlow(s, { type: 'harvest', status: 'csv' });
  ok(s.phase === 'importing' && statusText(s).includes('Importing'), 'harvest data → importing, status narrates');
  s = reduceFlow(s, { type: 'imported', inserted: 3 });
  ok(s.phase === 'done' && statusText(s) === 'Imported 3 new journeys from TfL.', 'import done → success message with count');
}
ok(statusText(run([
  { type: 'loaded', url: JOURNEY_HISTORY_URL },
  { type: 'harvest', status: 'rows' },
  { type: 'imported', inserted: 1 },
])) === 'Imported 1 new journey from TfL.', 'singular count reads correctly');
{
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 0 },
  ]);
  ok(s.phase === 'done' && statusText(s).includes('up to date'), 'zero new journeys says so explicitly');
}
{
  const s = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }]);
  ok(s.phase === 'done' && s.inserted === 0 && statusText(s).includes('No journey history'),
    'empty report from a confirmed history page → explicit no-history message');
}

// --- TfL-12: dashboard-after-challenge steering ---
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  s = reduceFlow(s, { type: 'harvest', status: 'challenge' });
  ok(s.phase === 'challenge' && !isTerminal(s) && statusText(s).toLowerCase().includes('security check'),
    'robot check → challenge phase: no harvest verdict, no terminal state, status invites solving it');
  ok(reduceFlow(s, { type: 'harvest', status: 'empty' }) === s,
    'no-history can NEVER be concluded while the challenge is up');
  // Challenge solved — TfL redirects to the My Account dashboard.
  s = reduceFlow(s, { type: 'loaded', url: DASHBOARD_URL });
  ok(s.phase === 'harvesting', 'post-challenge dashboard is harvested (the script identifies it), not trusted');
  s = reduceFlow(s, { type: 'harvest', status: 'wrong-page' });
  ok(s.phase === 'steering' && s.target === JOURNEY_HISTORY_URL && s.steers === 1,
    'dashboard reported as wrong-page → steer to the journey history, never a verdict');
  ok(statusText(s).includes('journey history'), 'steering narrated in the status bar');
  // Steered navigation lands on the real history page and the flow finishes.
  s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 2 },
  ], s);
  ok(s.phase === 'done' && s.inserted === 2, 'flow completes after challenge → dashboard → steer → history');
}

// --- TfL-12: no-history verdict only ever from a history page ---
{
  // The machine only reaches done-no-history via a harvest 'empty', and the
  // script only reports 'empty' from a confirmed history page. Every other
  // report from an intermediate page steers or waits:
  const harvesting = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: DASHBOARD_URL });
  const wrong = reduceFlow(harvesting, { type: 'harvest', status: 'wrong-page' });
  ok(wrong.phase === 'steering', 'wrong-page → steering, not done');
  const signedOut = reduceFlow(harvesting, { type: 'harvest', status: 'signed-out' });
  ok(signedOut.phase === 'signed-out', 'signed-out → wait for the user, not done');
  ok(reduceFlow(wrong, { type: 'harvest', status: 'empty' }) === wrong
    && reduceFlow(signedOut, { type: 'harvest', status: 'empty' }) === signedOut,
    'a stray empty report outside an active harvest is absorbed');
}

// --- TfL-12: steer cap — a redirect loop errors instead of spinning ---
{
  let s: FlowState = INITIAL_FLOW;
  for (let i = 0; i < MAX_STEERS; i++) {
    s = reduceFlow(s, { type: 'loaded', url: DASHBOARD_URL });
    s = reduceFlow(s, { type: 'harvest', status: 'wrong-page' });
    ok(s.phase === 'steering' && s.steers === i + 1, `steer ${i + 1}/${MAX_STEERS} allowed`);
  }
  s = reduceFlow(s, { type: 'loaded', url: DASHBOARD_URL });
  s = reduceFlow(s, { type: 'harvest', status: 'wrong-page' });
  ok(s.phase === 'error' && statusText(s).includes('journey history'),
    'one wrong page too many → error, never an infinite steer loop');
}

// --- TfL-12: duplicate / expired card entries ---
{
  // Luke's account: MANY expired-flagged •5006 entries. Unexpired cards are
  // visited; expired-flagged ones are skipped when any unexpired card exists.
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    {
      type: 'harvest', status: 'cards', cards: [
        { href: CARD_A, label: 'Visa ending in 5006', expired: true },
        { href: CARD_B, label: 'Visa ending in 5006', expired: true },
        { href: CARD_C, label: 'Visa ending in 5006', expired: false },
      ],
    },
  ]);
  ok(s.phase === 'steering' && s.target === CARD_C && s.queue.length === 0,
    'card picker: only the unexpired duplicate is visited');
}
{
  // TfL's expired flags are unreliable — if EVERY entry is flagged, try all.
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    {
      type: 'harvest', status: 'cards', cards: [
        { href: CARD_A, label: 'Visa ending in 5006', expired: true },
        { href: CARD_B, label: 'Visa ending in 5006', expired: true },
      ],
    },
  ]);
  ok(s.phase === 'steering' && s.target === CARD_A && s.queue[0] === CARD_B,
    'all entries expired-flagged → flags distrusted, every card queued');
}
{
  // 3+ duplicates where only one has journeys: visit each in turn, the one
  // with data imports, the empties pass through, totals merge.
  let s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    {
      type: 'harvest', status: 'cards', cards: [
        { href: CARD_A, label: 'Visa ending in 5006', expired: true },
        { href: CARD_B, label: 'Visa ending in 5006', expired: true },
        { href: CARD_C, label: 'Visa ending in 5006', expired: true },
      ],
    },
  ]);
  ok(s.phase === 'steering' && s.target === CARD_A, 'duplicate sweep: first •5006 entry visited');
  s = run([{ type: 'loaded', url: CARD_A }, { type: 'harvest', status: 'empty' }], s);
  ok(s.phase === 'steering' && s.target === CARD_B, 'first card empty → on to the next duplicate, no verdict yet');
  s = run([
    { type: 'loaded', url: CARD_B },
    { type: 'harvest', status: 'rows' },
    { type: 'imported', inserted: 4 },
  ], s);
  ok(s.phase === 'steering' && s.target === CARD_C, 'card with journeys imports, then the sweep continues');
  s = run([{ type: 'loaded', url: CARD_C }, { type: 'harvest', status: 'empty' }], s);
  ok(s.phase === 'done' && s.inserted === 4 && statusText(s) === 'Imported 4 new journeys from TfL.',
    'sweep done → merged total from the one card that had journeys');
}
{
  // Cards listed again (card switcher on every page) never loop the flow.
  let s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'cards', cards: [{ href: CARD_A, label: 'Visa ending in 5006' }] },
    { type: 'loaded', url: CARD_A },
  ]);
  const again = reduceFlow(s, { type: 'harvest', status: 'cards', cards: [{ href: CARD_A, label: 'Visa ending in 5006' }] });
  ok(again.phase === 'error', 'only already-visited cards left and nothing harvested → error, not a false no-history');
  s = run([
    { type: 'harvest', status: 'rows', cards: [{ href: CARD_A, label: 'Visa ending in 5006' }] },
    { type: 'imported', inserted: 1 },
  ], s);
  ok(s.phase === 'done' && s.inserted === 1, 'visited card re-listed alongside data → not re-queued, flow finishes');
}
{
  // A page listing an absurd number of cards stays bounded.
  const many = Array.from({ length: 30 }, (_, i) => ({ href: `${CARD_A}?n=${i}`, label: 'Visa ending in 5006' }));
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'cards', cards: many },
  ]);
  ok(s.phase === 'steering' && 'queue' in s && s.queue.length + s.visited.length === MAX_CARDS,
    `card sweep capped at ${MAX_CARDS} visits`);
}

// --- signed-out: the login page IS the sign-in UX, flow continues after ---
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'nav', url: LOGIN_URL });
  ok(s.phase === 'signed-out' && statusText(s).toLowerCase().includes('sign in'),
    'redirect to login mid-navigation → signed-out, status invites sign-in');
  ok(reduceFlow(s, { type: 'loaded', url: LOGIN_URL }).phase === 'signed-out', 'login page load keeps waiting for the user');
  // Post-login landing on the dashboard: harvested, identified, steered.
  s = run([{ type: 'loaded', url: DASHBOARD_URL }, { type: 'harvest', status: 'wrong-page' }], s);
  ok(s.phase === 'steering' && s.target === JOURNEY_HISTORY_URL, 'post-login dashboard → steered to journey history');
  const done = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 2 },
  ], s);
  ok(done.phase === 'done' && done.inserted === 2, 'flow completes after in-sheet sign-in');
}
ok(run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'signed-out' }]).phase === 'signed-out',
  'harvest script can also report signed-out (password field on page)');

// --- duplicate / late harvest reports don't restart the import ---
{
  const importing = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'csv' }]);
  ok(reduceFlow(importing, { type: 'harvest', status: 'csv' }) === importing, 'duplicate harvest report while importing is absorbed');
  ok(reduceFlow(importing, { type: 'harvest', status: 'empty' }) === importing, 'late empty report while importing is absorbed');
  ok(reduceFlow(importing, { type: 'loaded', url: JOURNEY_HISTORY_URL }).phase === 'importing', 'page reload while importing does not restart harvest');
  ok(reduceFlow(INITIAL_FLOW, { type: 'imported', inserted: 5 }) === INITIAL_FLOW, 'stray imported event outside an import is absorbed');
}

// --- cancel is safe from every live phase ---
for (const mk of [
  () => INITIAL_FLOW,
  () => reduceFlow(INITIAL_FLOW, { type: 'nav', url: LOGIN_URL }),
  () => reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL }),
  () => run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'challenge' }]),
  () => run([{ type: 'loaded', url: DASHBOARD_URL }, { type: 'harvest', status: 'wrong-page' }]),
  () => run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'csv' }]),
]) {
  const s = mk();
  const c = reduceFlow(s, { type: 'cancel' });
  ok(c.phase === 'cancelled', `cancel from '${s.phase}' → cancelled`);
}

// --- errors surface, never silent ---
{
  const s = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'error', message: 'boom' }]);
  ok(s.phase === 'error' && statusText(s).includes('boom'), 'harvest error → error phase with the message');
}
ok(reduceFlow(INITIAL_FLOW, { type: 'web-error', message: 'net down' }).phase === 'error', 'page load failure → error phase');
ok(run([
  { type: 'loaded', url: JOURNEY_HISTORY_URL },
  { type: 'harvest', status: 'csv' },
  { type: 'import-failed', message: 'db locked' },
]).phase === 'error', 'import failure → error phase');

// --- terminal states absorb everything ---
{
  const done = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }]);
  const cancelled = reduceFlow(INITIAL_FLOW, { type: 'cancel' });
  const errored = reduceFlow(INITIAL_FLOW, { type: 'web-error', message: 'x' });
  ok(isTerminal(done) && isTerminal(cancelled) && isTerminal(errored), 'done/cancelled/error are terminal');
  const late: FlowEvent[] = [
    { type: 'cancel' },
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'challenge' },
    { type: 'harvest', status: 'wrong-page' },
    { type: 'harvest', status: 'cards', cards: [{ href: CARD_A }] },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 9 },
    { type: 'web-error', message: 'y' },
  ];
  ok(run(late, done) === done && run(late, cancelled) === cancelled && run(late, errored) === errored,
    'late events after a terminal state change nothing');
}

console.log(`\ntest-refresh-flow: all ${passed} assertions passed.`);
