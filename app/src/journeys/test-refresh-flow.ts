// Visible-refresh state machine tests (TfL-11/12/13) — run with:
//   node --experimental-strip-types src/journeys/test-refresh-flow.ts
import assert from 'node:assert/strict';
import { JOURNEY_HISTORY_URL } from './autofetch.ts';
import {
  canHandover,
  CONTACTLESS_HISTORY_URL,
  doneMessage,
  type FlowEvent,
  type FlowState,
  HISTORY_URL,
  historyUrlsFor,
  INITIAL_FLOW,
  isAccountDashboard,
  isChallengeTitle,
  isContactlessDashboard,
  isLoginUrl,
  isPaused,
  isTerminal,
  makeInitialFlow,
  MAX_CARDS,
  MAX_STEERS,
  NEW_STATEMENTS_URL,
  OYSTER_HISTORY_URL,
  progressOf,
  reduceFlow,
  startUrlFor,
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

// Helper: close the direct CSV phase after a classic history sweep. When the
// queue empties the flow flips straight to in-place harvesting (TfL-18 — the
// statements page is gone, so nothing navigates); this event simulates the
// direct fetch failing and the flow finishing gracefully.
const CLOSE_DIRECT: FlowEvent[] = [
  { type: 'direct-failed' },
];

// --- URL classification ---
ok(HISTORY_URL === JOURNEY_HISTORY_URL && CONTACTLESS_HISTORY_URL === JOURNEY_HISTORY_URL,
  "urls: steering target matches the harvest module's history URL");
ok(isLoginUrl(LOGIN_URL) && isLoginUrl('https://contactless.tfl.gov.uk/SignIn'), 'urls: login pages recognised');
ok(!isLoginUrl(JOURNEY_HISTORY_URL) && !isLoginUrl(HOME_URL), 'urls: contactless pages are not login pages');
ok(!isLoginUrl(DASHBOARD_URL), 'urls: the signed-in My Account dashboard is NOT a login page (TfL-12)');
ok(isAccountDashboard(DASHBOARD_URL) && isAccountDashboard('https://account.tfl.gov.uk/MyAccount'),
  'urls: account.tfl.gov.uk non-login pages are the account dashboard (TfL-15)');
ok(isAccountDashboard('https://contactless.tfl.gov.uk/Dashboard'),
  'urls: contactless.tfl.gov.uk/Dashboard is also treated as account dashboard (TfL-16)');
ok(isContactlessDashboard('https://contactless.tfl.gov.uk/Dashboard')
  && isContactlessDashboard('https://contactless.tfl.gov.uk/dashboard?x=1')
  && !isContactlessDashboard(DASHBOARD_URL) && !isContactlessDashboard(CONTACTLESS_HISTORY_URL),
  'urls: the contactless Dashboard specifically is recognised (TfL-17), account dashboard is not');
ok(!isAccountDashboard(LOGIN_URL), 'urls: login pages are NOT treated as the account dashboard');
ok(!isAccountDashboard(JOURNEY_HISTORY_URL) && !isAccountDashboard(HOME_URL),
  'urls: contactless pages are not the account dashboard');
ok(startUrlFor('contactless') === CONTACTLESS_HISTORY_URL && startUrlFor('both') === CONTACTLESS_HISTORY_URL,
  'urls: contactless modes start on the history page (TfL-15)');
ok(startUrlFor('oyster') === OYSTER_HISTORY_URL, 'urls: oyster mode starts on the Oyster history page');
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
  const steered = run([{ type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' }], s);
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
    ...CLOSE_DIRECT,
  ], s);
  ok(s.phase === 'done' && s.inserted === 5, 'both-mode sweep completes with the Oyster journeys imported');
}

// --- happy path: load → harvest → import → direct CSV → done, narrated ---
ok(INITIAL_FLOW.phase === 'loading' && statusText(INITIAL_FLOW).includes('Loading'), 'flow starts loading, status says so');
{
  let s = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  ok(s.phase === 'harvesting' && statusText(s).includes('journey history'), 'history page loaded → harvesting, status narrates');
  s = reduceFlow(s, { type: 'harvest', status: 'csv' });
  ok(s.phase === 'importing' && statusText(s).includes('Importing'), 'harvest data → importing, status narrates');
  s = reduceFlow(s, { type: 'imported', inserted: 3 });
  // Queue exhausted → direct CSV attempt runs in place, no navigation (TfL-18).
  ok(s.phase === 'harvesting' && 'directTried' in s && s.directTried && !s.directCsv && s.historySwept,
    'history done → in-place direct CSV attempt, statements steer retired');
  s = run(CLOSE_DIRECT, s);
  ok(s.phase === 'done' && statusText(s) === 'Imported 3 new journeys from TfL.', 'import done → success message with count');
}
ok(statusText(run([
  { type: 'loaded', url: JOURNEY_HISTORY_URL },
  { type: 'harvest', status: 'rows' },
  { type: 'imported', inserted: 1 },
  ...CLOSE_DIRECT,
])) === 'Imported 1 new journey from TfL.', 'singular count reads correctly');
{
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 0 },
    ...CLOSE_DIRECT,
  ]);
  ok(s.phase === 'done' && statusText(s).includes('up to date'), 'zero new journeys says so explicitly');
}
{
  const s = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }, ...CLOSE_DIRECT]);
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
    ...CLOSE_DIRECT,
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
    ...CLOSE_DIRECT,
  ], resumed);
  ok(done.phase === 'done' && done.inserted === 2, 'flow completes after in-sheet sign-in');
}
{
  // TfL-15: account dashboard pause — same contract as signed-out.
  const ad = reduceFlow(INITIAL_FLOW, { type: 'nav', url: DASHBOARD_URL });
  ok(ad.phase === 'account-dashboard' && isPaused(ad) && !isTerminal(ad),
    'account dashboard nav → account-dashboard pause, flow paused');
  ok(statusText(ad).includes('Continue'), 'account-dashboard status points at the Continue button');
  ok(reduceFlow(ad, { type: 'loaded', url: DASHBOARD_URL }) === ad,
    'page loads during account-dashboard are ignored — no injection');
  ok(reduceFlow(ad, { type: 'nav', url: HOME_URL }) === ad,
    'navigations during account-dashboard are ignored — no steering');
  ok(reduceFlow(ad, { type: 'harvest', status: 'wrong-page' }) === ad,
    'stale harvest reports during account-dashboard are absorbed');
  ok(reduceFlow(ad, { type: 'web-error', message: 'x' }) === ad,
    'page errors while the user navigates do not kill the refresh');
  // Same detection from 'loaded' event (TfL-15 primary trigger).
  const adLoaded = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: DASHBOARD_URL });
  ok(adLoaded.phase === 'account-dashboard', 'account dashboard load → account-dashboard pause');
  // User navigated to their contactless history and tapped Continue:
  const cont = reduceFlow(ad, { type: 'handover' });
  ok(cont.phase === 'harvesting', 'Continue from account-dashboard → harvest whatever page is showing');
  const adDone = run([
    { type: 'harvest', status: 'wrong-page' },
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 3 },
    ...CLOSE_DIRECT,
  ], cont);
  ok(adDone.phase === 'done' && adDone.inserted === 3, 'flow completes after account-dashboard → Continue → history');
}
// --- TfL-17: contactless Dashboard gets one in-place direct CSV attempt ---
const CONTACTLESS_DASHBOARD = 'https://contactless.tfl.gov.uk/Dashboard';
{
  // TfL 302s every steer to the Dashboard — instead of parking, the flow
  // harvests right there (the direct script fetches the CSVs same-origin).
  const nav = reduceFlow(INITIAL_FLOW, { type: 'nav', url: CONTACTLESS_DASHBOARD });
  ok(nav === INITIAL_FLOW, 'Dashboard nav with the direct attempt pending → wait for loaded, no park');
  const h = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: CONTACTLESS_DASHBOARD });
  ok(h.phase === 'harvesting' && 'directTried' in h && h.directTried && !h.directCsv,
    'Dashboard loaded → harvesting in place, one-shot spent, statements steer disarmed');
  // Direct fetch succeeds → import → done, zero steering.
  const done = run([{ type: 'harvest', status: 'csv' }, { type: 'imported', inserted: 4 }], h);
  ok(done.phase === 'done' && done.inserted === 4 && 'steers' in h && h.steers === 0,
    'Dashboard direct fetch success → imported → done without a single steer');
  // Direct fetch fails ON the Dashboard → park for the user (steering would
  // just bounce back here), and Continue keeps working.
  const parked = reduceFlow(h, { type: 'direct-failed', url: CONTACTLESS_DASHBOARD });
  ok(parked.phase === 'account-dashboard' && isPaused(parked),
    'direct fetch failed on the Dashboard → parked for the user, not a steer bounce');
  const resumed = reduceFlow(parked, { type: 'handover' });
  ok(resumed.phase === 'harvesting', 'Continue still resumes from the Dashboard park');
  // The in-place attempt is one shot: a later Dashboard landing parks normally.
  const again = reduceFlow(resumed, { type: 'loaded', url: CONTACTLESS_DASHBOARD });
  ok(again.phase === 'account-dashboard', 'a second Dashboard landing parks — no retry loop');
}
{
  // 'both' mode: Dashboard direct success still hands over to Oyster.
  const s = run([
    { type: 'loaded', url: CONTACTLESS_DASHBOARD },
    { type: 'harvest', status: 'csv' },
    { type: 'imported', inserted: 2 },
  ], makeInitialFlow('both'));
  ok(s.phase === 'steering' && s.target === OYSTER_HISTORY_URL && s.inserted === 2,
    'both-mode Dashboard direct success → Oyster history still queued and visited');
}
{
  // Oyster mode has no direct CSV — the Dashboard parks as before.
  const s = reduceFlow(makeInitialFlow('oyster'), { type: 'loaded', url: CONTACTLESS_DASHBOARD });
  ok(s.phase === 'account-dashboard', 'oyster mode: Dashboard still parks (no direct attempt to make)');
}
{
  // Oyster has no directCsv fallback (makeInitialFlow sets it false for oyster).
  // In contactless, a wrong-page steer → CSV fetch gives one last chance.
  // In Oyster the CSV endpoint doesn't exist — so misclassification must not
  // attempt a CSV fetch; it must reach signed-out (via bounce) or done/no-history,
  // never 'harvesting: directCsv'. The empty-history path goes straight to done.
  const s = makeInitialFlow('oyster');
  ok(!('directCsv' in s) || !s.directCsv, 'oyster: directCsv is false from the start — no CSV endpoint exists');
  const empty = run([
    { type: 'loaded', url: OYSTER_HISTORY_URL },
    { type: 'harvest', status: 'empty' },
  ], s);
  ok(empty.phase === 'done' && empty.inserted === 0 && statusText(empty).includes('No journey history'),
    'oyster: empty history page → done immediately, no in-place CSV attempt');
  const bounced = run([
    { type: 'loaded', url: OYSTER_HISTORY_URL },
    { type: 'harvest', status: 'wrong-page' },
    { type: 'loaded', url: OYSTER_HISTORY_URL },
    { type: 'harvest', status: 'wrong-page' },
  ], s);
  ok(bounced.phase === 'signed-out' && !('directCsv' in bounced && bounced.directCsv),
    'oyster: bounce → signed-out, no CSV fallback armed in either direction');
}
{
  // A direct failure on the statements page itself keeps the classic fallback.
  const s = run([
    { type: 'loaded', url: NEW_STATEMENTS_URL },
    { type: 'direct-failed', url: NEW_STATEMENTS_URL },
  ], INITIAL_FLOW);
  ok(s.phase === 'steering' && s.target === CONTACTLESS_HISTORY_URL && s.steers === 1,
    'direct-failed on the statements page → classic steer to the history, unchanged');
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
  s = run([{ type: 'handover' }, { type: 'harvest', status: 'rows' }, { type: 'imported', inserted: 2 }, ...CLOSE_DIRECT], s);
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
  const steering = run([{ type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' }]);
  ok(reduceFlow(steering, { type: 'handover' }).phase === 'harvesting', 'handover works from a stalled steer');
  const acctDash = reduceFlow(INITIAL_FLOW, { type: 'nav', url: DASHBOARD_URL });
  ok(reduceFlow(acctDash, { type: 'handover' }).phase === 'harvesting', 'handover works from account-dashboard pause');
  const harvesting = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: JOURNEY_HISTORY_URL });
  ok(reduceFlow(harvesting, { type: 'handover' }).phase === 'harvesting', 'handover re-harvests from harvesting');
  const importing = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'csv' }]);
  ok(reduceFlow(importing, { type: 'handover' }) === importing, 'handover never interrupts a running import');
  ok(canHandover(INITIAL_FLOW) && canHandover(steering) && canHandover(harvesting) && !canHandover(importing),
    'Continue button offered in live phases, hidden while importing');
  const done = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }, ...CLOSE_DIRECT]);
  ok(!canHandover(done) && reduceFlow(done, { type: 'handover' }) === done, 'no Continue once the flow is finished');
}

// --- TfL-12: no-history verdict only ever from a history page ---
{
  // The machine only reaches done-no-history via a harvest 'empty', and the
  // script only reports 'empty' from a confirmed history page. Every other
  // report from an intermediate page steers or waits. Use HOME_URL (a
  // contactless page that's not a history page) to exercise wrong-page —
  // DASHBOARD_URL now triggers account-dashboard pause, not harvesting.
  const harvesting = reduceFlow(INITIAL_FLOW, { type: 'loaded', url: HOME_URL });
  const wrong = reduceFlow(harvesting, { type: 'harvest', status: 'wrong-page' });
  ok(wrong.phase === 'steering', 'wrong-page → steering, not done');
  const signedOut = reduceFlow(harvesting, { type: 'harvest', status: 'signed-out' });
  ok(signedOut.phase === 'signed-out', 'signed-out → wait for the user, not done');
  ok(reduceFlow(wrong, { type: 'harvest', status: 'empty' }) === wrong
    && reduceFlow(signedOut, { type: 'harvest', status: 'empty' }) === signedOut,
    'a stray empty report outside an active harvest is absorbed');
}

// --- TfL-OYSTER-SIGNIN: bounce detection — signed-out page redirects without a login URL ---
//
// Oyster's signed-out state redirects to a page whose URL doesn't match
// isLoginUrl/isUnregisteredUrl. Before this fix: wrong-page → steer × 4 →
// error "kept landing away from the journey history page". Fix: steer to home
// at most once; if the next page is *also* wrong-page, TfL keeps redirecting
// us — we're signed out. Park as signed-out and let the user sign in.
// URL-independent, survives TfL renaming paths.
{
  // Contactless: two consecutive wrong-pages → signed-out after one steer.
  let s = run([{ type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' }]);
  ok(s.phase === 'steering' && s.steers === 1, 'first wrong-page → one steer to home');
  s = run([{ type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' }], s);
  ok(s.phase === 'signed-out' && isPaused(s),
    'second consecutive wrong-page (bounce) → signed-out, not another steer or error');
  ok(statusText(s).includes('Sign in') && statusText(s).includes('Continue'),
    'signed-out copy points at the Continue button');
}
{
  // Oyster: same bounce pattern, home is the Oyster URL.
  const OYSTER_SIGNOUT = 'https://oyster.tfl.gov.uk/oyster/index.do'; // typical signed-out redirect
  let s = run([{ type: 'loaded', url: OYSTER_SIGNOUT }, { type: 'harvest', status: 'wrong-page' }], makeInitialFlow('oyster'));
  ok(s.phase === 'steering' && s.target === OYSTER_HISTORY_URL && s.steers === 1,
    'oyster: first wrong-page steers to the Oyster history page');
  s = run([{ type: 'loaded', url: OYSTER_SIGNOUT }, { type: 'harvest', status: 'wrong-page' }], s);
  ok(s.phase === 'signed-out' && isPaused(s),
    'oyster: second consecutive wrong-page → signed-out, not four steers then error');
}
{
  // Both mode: bounce fires inside the Oyster section too.
  let s = makeInitialFlow('both');
  s = run([
    { type: 'loaded', url: CONTACTLESS_HISTORY_URL }, { type: 'harvest', status: 'empty' }, // contactless done
    { type: 'loaded', url: OYSTER_HISTORY_URL }, { type: 'harvest', status: 'wrong-page' }, // first wrong-page
    { type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' },           // bounce
  ], s);
  ok(s.phase === 'signed-out' && isPaused(s), 'both mode: Oyster bounce also parks as signed-out');
}
{
  // Bounce flag resets after a confirmed real harvest — a later wrong-page
  // on a different card still gets one recovery steer.
  let s = run([
    { type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' },           // steer 1, flag set
    { type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' },     // real harvest, flag cleared
    { type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' },           // new wrong-page, flag clear
  ]);
  ok(s.phase === 'steering', 'bounce flag resets after a confirmed history page — later wrong-page still gets one steer');
}
{
  // Handover from signed-out (via bounce) works the same as any other sign-in.
  let s = run([
    { type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' },
    { type: 'loaded', url: HOME_URL }, { type: 'harvest', status: 'wrong-page' },
  ]);
  ok(s.phase === 'signed-out');
  s = run([
    { type: 'handover' }, { type: 'harvest', status: 'rows' },
    { type: 'imported', inserted: 3 }, ...CLOSE_DIRECT,
  ], s);
  ok(s.phase === 'done' && s.inserted === 3, 'Continue from bounce-detected signed-out completes the refresh');
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
  s = run([{ type: 'loaded', url: CARD_C }, { type: 'harvest', status: 'empty' }, ...CLOSE_DIRECT], s);
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
    ...CLOSE_DIRECT,
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
  () => reduceFlow(INITIAL_FLOW, { type: 'nav', url: DASHBOARD_URL }),
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
  const done = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'empty' }, ...CLOSE_DIRECT]);
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

// --- TfL-25: the cookie banner that made the refresh unusable ---
//
// Luke, 29-Jul: "I got this cookies pop up on an log in. The browser doesn't
// let me accept cookies or go back". The WebView was fine; the state machine
// was the problem. An unrecognised page reports 'wrong-page', and the answer to
// wrong-page is to put window.location back on the history URL — so the consent
// page loaded, got classified as a dud and was navigated out from under him
// about a second later. Every tap on "Accept all cookies" raced a reload it
// couldn't win, and after MAX_STEERS the refresh errored.
//
// These assertions pin the fix at its actual mechanism: consent is a PAUSED
// phase, and paused is already the no-steering/no-injection guarantee TfL-13
// gave login and robot checks. What must never regress is the steer.
const CONSENT_URL = 'https://contactless.tfl.gov.uk/CookieSettings';
{
  const s = run([{ type: 'loaded', url: CONSENT_URL }]);
  ok(s.phase === 'consent' && isPaused(s), "cookie page → paused, not a 'wrong page' to be steered off");
  ok(!isTerminal(s) && canHandover(s), 'cookie page keeps Continue available');
  // The regression that matters: no steering phase means no window.location
  // injection, so the buttons stay tappable for as long as the user needs.
  const later = run([
    { type: 'nav', url: CONSENT_URL },
    { type: 'loaded', url: CONSENT_URL },
    { type: 'harvest', status: 'wrong-page' }, // a report in flight from before the pause
  ], s);
  ok(later.phase === 'consent', 'while the cookie page is up nothing steers it away');
}
{
  // Caught on 'nav' too, which fires before the page has finished loading —
  // the pause has to land before the steer, not after it.
  const s = run([{ type: 'nav', url: CONSENT_URL }]);
  ok(s.phase === 'consent', 'cookie page recognised on navigation, before load completes');
}
{
  // TfL also draws the dialog OVER the page it was asked for; only the DOM can
  // see that, so the harvest script reports it.
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'consent' },
  ]);
  ok(s.phase === 'consent' && isPaused(s), 'consent dialog reported from the page → paused');
}
{
  // Continue is the only thing that resumes, and it resumes into a harvest of
  // whatever page is now showing — the same handover login already uses.
  let s = run([{ type: 'loaded', url: CONSENT_URL }, { type: 'handover' }]);
  ok(s.phase === 'harvesting', 'Continue from the cookie page resumes the harvest');
  s = run([{ type: 'harvest', status: 'rows' }, { type: 'imported', inserted: 3 }, ...CLOSE_DIRECT], s);
  ok(s.phase === 'done' && s.inserted === 3, 'cookie pause costs nothing — the refresh completes after it');
}
{
  const s = reduceFlow(run([{ type: 'loaded', url: CONSENT_URL }]), { type: 'cancel' });
  ok(s.phase === 'cancelled', "cancel from 'consent' → cancelled");
}

// --- TfL-25: TfL's own captcha, which a first-time user hits immediately ---
//
// Verified live: an unauthenticated GET of the contactless history page 302s to
// /UnregisteredCustomer/Captcha. That is neither a login form nor a Cloudflare
// challenge, so before this it was a 'wrong-page' as well — meaning a brand-new
// public user's very first refresh steered off TfL's captcha four times and
// then errored. Public-release blocker (Luke, msg 4606).
{
  const s = run([{ type: 'loaded', url: 'https://contactless.tfl.gov.uk/UnregisteredCustomer/Captcha' }]);
  ok(s.phase === 'challenge' && isPaused(s), "TfL's own captcha → paused challenge, not a dud page");
}
{
  const s = run([{ type: 'nav', url: 'https://contactless.tfl.gov.uk/UnregisteredCustomer/SomethingElse' }]);
  ok(s.phase === 'signed-out' && isPaused(s), 'unregistered-customer gate → signed-out, not a dud page');
}
{
  // Order matters: an OIDC sign-in URL carrying a consent parameter is still a
  // login, so isLoginUrl is checked first.
  const s = run([{ type: 'loaded', url: 'https://account.tfl.gov.uk/signin?prompt=consent' }]);
  ok(s.phase === 'signed-out', 'sign-in URL with a consent parameter parks as signed-out, not consent');
}

// --- TfL-25: hardened for any number of cards (Luke, msg 4606) ---
{
  // The cap is a runaway guard, and when it bites it says so. A cap that
  // truncated silently would read as "we checked everything" when it hadn't.
  const many = Array.from({ length: MAX_CARDS + 3 }, (_, i) => ({ href: `https://contactless.tfl.gov.uk/Card/${i}/History` }));
  let s = run([{ type: 'loaded', url: JOURNEY_HISTORY_URL }, { type: 'harvest', status: 'cards', cards: many }]);
  ok(s.phase === 'steering' && s.visited.length + s.queue.length + 1 <= MAX_CARDS + 1,
    'more cards than the cap → queue bounded');
  ok(s.cardsDropped === 3, 'cards the cap refused are counted, not forgotten');
  // TfL's card switcher re-lists everything on every page, so the overflow is
  // seen again and again. The count is per-encounter rather than per-card: it
  // answers "did we look at everything?" (no) and drives one sentence of copy.
  // Precision beyond that would need a set of skipped hrefs to no benefit.
  const again = run([{ type: 'loaded', url: s.phase === 'steering' ? s.target : '' },
    { type: 'harvest', status: 'cards', cards: many }], s);
  ok('cardsDropped' in again && again.cardsDropped > 3,
    're-listing the same overflow on a later page keeps counting the skips');
}
{
  // The closing message tells the user what was left, in their words, with an
  // action — the alternative is a cheerful "all up to date" that is false.
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'cards', cards: Array.from({ length: MAX_CARDS + 1 }, (_, i) => ({ href: `https://c.tfl/${i}` })) },
  ]);
  ok('cardsDropped' in s && s.cardsDropped === 1, 'one card over the cap is one card counted');
  const msg = doneMessage(4, 1);
  ok(msg.includes('4') && /1 further card wasn't checked/.test(msg) && msg.includes('refresh again'),
    'closing message names the skipped card and what to do about it');
  ok(/2 further cards weren't checked/.test(doneMessage(0, 2)), 'plural reads correctly');
  ok(!/further card/.test(doneMessage(4, 0)), 'nothing skipped → no noise about skipped cards');
}
{
  // The duplicate •5006 entries stay individually visited on purpose — see
  // enqueueCards. Only the identical LINK is deduplicated.
  const s = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    {
      type: 'harvest', status: 'cards', cards: [
        { href: CARD_A, label: 'Visa ending in 5006', expired: true },
        { href: CARD_A, label: 'Visa ending in 5006', expired: true },
        { href: CARD_B, label: 'Visa ending in 5006', expired: true },
      ],
    },
  ]);
  ok(s.phase === 'steering' && s.target === CARD_A && s.queue.length === 1 && s.queue[0] === CARD_B,
    'same link twice → one visit; same card number on a different link → still visited');
}

// --- TfL-25: progress, honest about what it does and does not know ---
{
  ok(progressOf({ phase: 'cancelled' }) === null, 'no progress bar once the refresh is over');
  const paused = run([{ type: 'loaded', url: CONSENT_URL }]);
  ok(progressOf(paused) === null, 'no progress bar while the machine is waiting on the user');
  const live = run([
    { type: 'loaded', url: JOURNEY_HISTORY_URL },
    { type: 'harvest', status: 'cards', cards: [{ href: CARD_A }, { href: CARD_B }] },
  ]);
  // History page done, card A in flight, card B queued, direct CSV still to go.
  const p = progressOf(live);
  ok(p !== null && p.label === 'Page 2 of 4' && p.done === 1,
    'progress counts pages started, the queue ahead, and the direct CSV step');
  const p2 = progressOf(run([{ type: 'loaded', url: CARD_A }, { type: 'harvest', status: 'empty' }], live));
  ok(p2 !== null && p2.done === 2 && p2.fraction > p!.fraction, 'finishing a page moves the bar');
  // A growing total is the honest reading: TfL only reveals the card list
  // partway through, and a bar that hit 100% while still working would lie.
  const grown = progressOf(run([{ type: 'harvest', status: 'cards', cards: [{ href: CARD_C }] }],
    run([{ type: 'loaded', url: CARD_A }], live)));
  ok(grown !== null && grown.total === 5, 'a card discovered mid-sweep grows the total rather than overflowing it');
  ok(grown!.fraction < 1, 'the bar never reads finished while pages remain');
}

console.log(`\ntest-refresh-flow: all ${passed} assertions passed.`);
