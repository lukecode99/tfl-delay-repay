// Visible-refresh state machine tests (TfL-11/12/13) — run with:
//   node --experimental-strip-types src/journeys/test-refresh-flow.ts
import assert from 'node:assert/strict';
import { JOURNEY_HISTORY_URL } from './autofetch.ts';
import {
  canHandover,
  CONTACTLESS_HISTORY_URL,
  type FlowEvent,
  type FlowState,
  HISTORY_URL,
  historyUrlsFor,
  INITIAL_FLOW,
  isChallengeTitle,
  isLoginUrl,
  isPaused,
  isTerminal,
  makeInitialFlow,
  MAX_CARDS,
  MAX_STEERS,
  OYSTER_HISTORY_URL,
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
ok(HISTORY_URL === JOURNEY_HISTORY_URL && CONTACTLESS_HISTORY_URL === JOURNEY_HISTORY_URL,
  'urls: steering target matches the harvest module’s history URL');
ok(isLoginUrl(LOGIN_URL) && isLoginUrl('https://contactless.tfl.gov.uk/SignIn'), 'urls: login pages recognised');
ok(!isLoginUrl(JOURNEY_HISTORY_URL) && !isLoginUrl(HOME_URL), 'urls: contactless pages are not login pages');
ok(!isLoginUrl(DASHBOARD_URL), 'urls: the signed-in My Account dashboard is NOT a login page (TfL-12)');
ok(isChallengeTitle('Just a moment...') && isChallengeTitle('Attention Required! | Cloudflare')
  && isChallengeTitle('Verify you are human'), 'titles: robot-check titles recognised');
ok(!isChallengeTitle('Journey history - Transport for London') && !isChallengeTitle(''),
  'titles: ordinary page titles are not challenges');

// --- TfL-13: fetch modes route to the right history section ---
ok(historyUrlsFor('contactless').length === 1 && historyUrlsFor('contactless')[0] === CONTACTLESS_HISTORY_URL,
  'mode contactless → contactless history only');
ok(historyUrlsFor('oyster').length === 1 && historyUrlsFor('oyster')[0] === OYSTER_HISTORY_URL,
  'mode oyster → Oyster history only');
ok(historyUrlsFor('both')[0] === CONTACTLESS_HISTORY_URL && historyUrlsFor('both')[1] === OYSTER_HISTORY_URL,
  'mode both → contactless first, Oyster queued behind');
{
  const s = makeInitialFlow('oyster');
  ok(s.phase === 'loading' && 'home' in s && s.home === OYSTER_HISTORY_URL && s.queue.length === 0,
    'oyster flow starts loading the Oyster history with nothing else queued');
  const steered = run([{ type: 'loaded', url: DASHBOARD_URL }, { type: 'harvest', status: 'wrong-page' }], s);
  ok(steered.phase === 'steering' && steered.target === OYSTER_HISTORY_URL,
    'oyster mode: wrong pages steer to the OYSTER history, not contactless');
}
{
  // Both mode: contactless section empty, Oyster has the journeys — totals merge.
  let s = makeInitialFlow('both');
  ok(s.phase === 'loading' && 'queue' in s && s.queue[0] === OYSTER_HISTORY_URL, 'both mode queues Oyster behind contactless');
  s = run([{ type: 'loaded', url: CONTACTLESS_HISTORY_URL }, { type: 'harvest', status: 'empty' }], s);
  ok(s.phase === 'steering' && s.target === OYSTER_HISTORY_URL,
    'contactless section empty → not a verdict, the Oyster section is next');
  s = run([
    { type: 'loaded', url: OYSTER_HISTORY_URL },
    { type: 'harvest', status: 'rows' },
    { type: 'imported', inserted: 5 },
  ], s);
  ok(s.phase === 'done' && s.inserted === 5, 'both-mode sweep completes with the Oyster journeys imported');
}

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

// --- TfL-13: login/challenge pause — the page is the user's, untouched ---
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  s = reduceFlow(s, { type: 'harvest', status: 'challenge' });
  ok(s.phase === 'challenge' && isPaused(s) && !isTerminal(s), 'robot check → challenge phase, flow paused');
  ok(statusText(s).includes('Continue'), 'challenge status points at the Continue button');
  // The component only injects in 'harvesting' and only steers in 'steering':
  // while paused, NO event short of handover may reach either phase.
  const challenge = s;
  ok(reduceFlow(challenge, { type: 'loaded', url: DASHBOARD_URL }) === challenge,
    'page loads during the challenge are ignored — zero injection while the user solves it');
  ok(reduceFlow(challenge, { type: 'nav', url: HOME_URL }) === challenge
    && reduceFlow(challenge, { type: 'nav', url: LOGIN_URL }) === challenge,
    'navigations during the challenge are ignored — zero steering');
  ok(reduceFlow(challenge, { type: 'harvest', status: 'wrong-page' }) === challenge
    && reduceFlow(challenge, { type: 'harvest', status: 'empty' }) === challenge
    && reduceFlow(challenge, { type: 'harvest', status: 'rows' }) === challenge,
    'stale harvest reports during the challenge are absorbed — no verdicts, no yanking the page');
  ok(reduceFlow(challenge, { type: 'web-error', message: 'x' }) === challenge,
    'a failed page while the user drives does not kill the refresh');
  // User solved it, landed wherever, tapped Continue:
  s = reduceFlow(challenge, { type: 'handover' });
  ok(s.phase === 'harvesting', 'Continue (handover) → harvest whatever page is showing');
  s = reduceFlow(s, { type: 'harvest', status: 'wrong-page' });
  ok(s.phase === 'steering' && s.target === JOURNEY_HISTORY_URL && s.steers === 1,
    'post-handover dashboard reported wrong-page → steered to the journey history');
  s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 2 },
  ], s);
  ok(s.phase === 'done' && s.inserted === 2, 'flow completes after challenge → Continue → steer → history');
}
{
  // Same pause contract for signed-out.
  const so = reduceFlow(INITIAL_FLOW, { type: 'nav', url: LOGIN_URL });
  ok(so.phase === 'signed-out' && isPaused(so) && statusText(so).includes('Continue'),
    'redirect to login → signed-out pause, status points at Continue');
  ok(reduceFlow(so, { type: 'loaded', url: LOGIN_URL }) === so
    && reduceFlow(so, { type: 'loaded', url: DASHBOARD_URL }) === so,
    'nothing auto-resumes after sign-in — post-login loads stay paused until Continue (TfL-13)');
  ok(reduceFlow(so, { type: 'harvest', status: 'csv' }) === so,
    'stale harvest data while signed-out is absorbed');
  const resumed = run([
    { type: 'handover' },
    { type: 'harvest', status: 'wrong-page' },
  ], so);
  ok(resumed.phase === 'steering' && resumed.target === JOURNEY_HISTORY_URL,
    'signed in + Continue → harvest → steer onwards');
  const done = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 2 },
  ], resumed);
  ok(done.phase === 'done' && done.inserted === 2, 'flow completes after in-sheet sign-in');
}
{
  // Pause must not lose sweep progress: handover resumes with queue/tallies intact.
  let s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    {
      type: 'harvest', status: 'cards', cards: [
        { href: CARD_A, label: 'Visa ending in 5006', expired: false },
        { href: CARD_B, label: 'Visa ending in 5006', expired: false },
      ],
    },
    { type: 'loaded', url: CARD_A },
    { type: 'harvest', status: 'rows' },
    { type: 'imported', inserted: 3 },
    { type: 'loaded', url: CARD_B },
    { type: 'harvest', status: 'signed-out' }, // session expired mid-sweep
  ]);
  ok(s.phase === 'signed-out', 'session expiry mid-sweep pauses');
  s = run([{ type: 'handover' }, { type: 'harvest', status: 'rows' }, { type: 'imported', inserted: 2 }], s);
  ok(s.phase === 'done' && s.inserted === 5, 'handover resumes the sweep with earlier imports intact');
}

// --- TfL-13: challenge spotted from the page title, injection-free ---
{
  const s = reduceFlow(INITIAL_FLOW, { type: 'nav', url: JOURNEY_HISTORY_URL, title: 'Just a moment...' });
  ok(s.phase === 'challenge', 'challenge title on navigation → paused before anything touches the page');
  ok(reduceFlow(INITIAL_FLOW, { type: 'nav', url: JOURNEY_HISTORY_URL, title: 'Journey history' }) === INITIAL_FLOW,
    'ordinary titles pass through');
}

// --- TfL-13: handover as an escape hatch from any stalled live phase ---
{
  ok(reduceFlow(INITIAL_FLOW, { type: 'handover' }).phase === 'harvesting', 'handover works from loading');
  const steering = run([{ type: 'loaded', url: DASHBOARD_URL }, { type: 'harvest', status: 'wrong-page' }]);
  ok(reduceFlow(steering, { type: 'handover' }).phase === 'harvesting', 'handover works from a stalled steer');
  const harvesting = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  ok(reduceFlow(harvesting, { type: 'handover' }).phase === 'harvesting', 'handover re-harvests from harvesting');
  const importing = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'csv' }]);
  ok(reduceFlow(importing, { type: 'handover' }) === importing, 'handover never interrupts a running import');
  ok(canHandover(INITIAL_FLOW) && canHandover(steering) && canHandover(harvesting) && !canHandover(importing),
    'Continue button offered in live phases, hidden while importing');
  const done = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }]);
  ok(!canHandover(done) && reduceFlow(done, { type: 'handover' }) === done, 'no Continue once the flow is finished');
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

// --- harvest script can also report signed-out (password field on page) ---
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
    { type: 'handover' },
    { type: 'imported', inserted: 9 },
    { type: 'web-error', message: 'y' },
  ];
  ok(run(late, done) === done && run(late, cancelled) === cancelled && run(late, errored) === errored,
    'late events after a terminal state change nothing');
}

console.log(`\ntest-refresh-flow: all ${passed} assertions passed.`);
