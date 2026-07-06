// Visible-refresh state machine tests (TfL-11) — run with:
//   node --experimental-strip-types src/journeys/test-refresh-flow.ts
import assert from 'node:assert/strict';
import { JOURNEY_HISTORY_URL } from './autofetch.ts';
import {
  type FlowEvent,
  type FlowState,
  INITIAL_FLOW,
  isHistoryUrl,
  isLoginUrl,
  isTerminal,
  loadAction,
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
const HOME_URL = 'https://contactless.tfl.gov.uk/HomePage';

// --- URL classification ---
ok(isLoginUrl(LOGIN_URL) && isLoginUrl('https://contactless.tfl.gov.uk/SignIn'), 'urls: login pages recognised');
ok(!isLoginUrl(JOURNEY_HISTORY_URL) && !isLoginUrl(HOME_URL), 'urls: contactless pages are not login pages');
ok(isHistoryUrl(JOURNEY_HISTORY_URL) && !isHistoryUrl(HOME_URL), 'urls: journey-history page recognised');

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
    'no journey table on the page → explicit no-history message');
}

// --- signed-out: the login page IS the sign-in UX, flow continues after ---
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'nav', url: LOGIN_URL });
  ok(s.phase === 'signed-out' && statusText(s).toLowerCase().includes('sign in'),
    'redirect to login mid-navigation → signed-out, status invites sign-in');
  ok(loadAction(s, LOGIN_URL) === 'none', 'login page: nothing injected — the user is using it');
  ok(loadAction(s, HOME_URL) === 'go-history', 'post-login landing off the history page → steer to journey history');
  ok(loadAction(s, JOURNEY_HISTORY_URL) === 'inject', 'post-login history page → harvest again');
  s = reduceFlow(s, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  const done = run([{ type: 'harvest', status: 'csv' }, { type: 'imported', inserted: 2 }], s);
  ok(done.phase === 'done' && done.inserted === 2, 'flow completes after in-sheet sign-in');
}
ok(run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'signed-out' }]).phase === 'signed-out',
  'harvest script can also report signed-out (password field on page)');

// --- loadAction guards ---
ok(loadAction(INITIAL_FLOW, JOURNEY_HISTORY_URL) === 'inject', 'first load of the history page injects');
ok(loadAction({ phase: 'importing' }, JOURNEY_HISTORY_URL) === 'none', 'no re-injection while importing');
ok(loadAction({ phase: 'done', message: '', inserted: 0 }, JOURNEY_HISTORY_URL) === 'none', 'no injection after the flow is over');

// --- duplicate / late harvest reports don't restart the import ---
{
  const importing = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'csv' }]);
  ok(reduceFlow(importing, { type: 'harvest', status: 'csv' }) === importing, 'duplicate harvest report while importing is absorbed');
  ok(reduceFlow(importing, { type: 'harvest', status: 'empty' }) === importing, 'late empty report while importing is absorbed');
  ok(reduceFlow(importing, { type: 'loaded', url: JOURNEY_HISTORY_URL }).phase === 'importing', 'page reload while importing does not restart harvest');
}

// --- cancel is safe from every live phase ---
for (const mk of [
  () => INITIAL_FLOW,
  () => reduceFlow(INITIAL_FLOW, { type: 'nav', url: LOGIN_URL }),
  () => reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL }),
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
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 9 },
    { type: 'web-error', message: 'y' },
  ];
  ok(run(late, done) === done && run(late, cancelled) === cancelled && run(late, errored) === errored,
    'late events after a terminal state change nothing');
}

console.log(`\ntest-refresh-flow: all ${passed} assertions passed.`);
