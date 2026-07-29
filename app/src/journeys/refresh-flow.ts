// Visible-refresh flow state machine (TfL-11/12/13). Pure module — node-testable.
//
// TfL-10's hidden WebView gave no on-device feedback, so the refresh runs
// inside a visible sheet showing the real TfL pages. This reducer owns the
// flow: what the status bar says, when the harvest script gets injected,
// where the WebView is steered, and when the sheet is finished. The harvest
// script, parser and dedupe are TfL-10's — this module is presentation +
// interruption handling + navigation.
//
// Login and robot-check pages hand the page over to the user completely
// (TfL-13): the moment either is detected the flow is PAUSED — no steering,
// no injection, no reaction to page loads — because injected navigations were
// interfering while Luke solved the challenge. The user browses and signs in
// freely and taps Continue when done; only that 'handover' event resumes the
// automation. The same handover works from any stalled state as an escape
// hatch: navigate manually, tap Continue, and the harvest picks up from
// whatever page is showing.
//
// Post-login/post-challenge TfL likes to land on the My Account dashboard —
// the harvest script reports that as 'wrong-page' and the flow steers on to
// the journey history instead of concluding anything there (TfL-12). When the
// account lists several cards (Luke's has many expired-flagged duplicates),
// each usable card's history page is visited in turn and the imports merge —
// the dedupe index makes revisits harmless.

/** Contactless journey history. Duplicated from (not imported from)
 * autofetch.JOURNEY_HISTORY_URL so this module keeps zero runtime imports and
 * stays node-testable under --experimental-strip-types (Metro modules import
 * extensionless, node needs .ts) — the test suite asserts the two match. */
export const CONTACTLESS_HISTORY_URL = 'https://contactless.tfl.gov.uk/HomePage/7DayHistory';

/** Oyster journey history — a different site with its own login. */
export const OYSTER_HISTORY_URL = 'https://oyster.tfl.gov.uk/oyster/journeyHistory.do';

/** Back-compat alias; contactless is the default mode's home. */
export const HISTORY_URL = CONTACTLESS_HISTORY_URL;

/** Contactless statements base URL (TfL-14). The PAGE was removed by TfL
 * (TfL-18: 302 → Error/NotFound) but the DownloadJourneyCsv endpoint under it
 * survives (TfL-19 — journey statements, not the billing sibling builds 13–15
 * fetched), so this stays as the endpoint base. The flow never navigates here
 * any more — the direct fetch runs in place on whatever page is showing.
 * Duplicated from (not imported from) direct-csv.NEW_STATEMENTS_URL for the
 * same zero-runtime-imports reason as above; the tests assert the two match. */
export const NEW_STATEMENTS_URL = 'https://contactless.tfl.gov.uk/NewStatements';

/** Which journey-history section(s) the user's cards live in (TfL-13). */
export type FetchMode = 'contactless' | 'oyster' | 'both';

/** Meta-table key the persisted mode choice is stored under. */
export const FETCH_MODE_KEY = 'fetchMode';

/** History pages a mode visits, in visit order. */
export function historyUrlsFor(mode: FetchMode): string[] {
  if (mode === 'oyster') return [OYSTER_HISTORY_URL];
  if (mode === 'both') return [CONTACTLESS_HISTORY_URL, OYSTER_HISTORY_URL];
  return [CONTACTLESS_HISTORY_URL];
}

/**
 * First page a refresh loads (TfL-15): contactless modes start on the classic
 * history page; the direct CSV fetch is queued and runs after the history
 * sweep. Oyster has no statements endpoint.
 */
export function startUrlFor(mode: FetchMode): string {
  return mode === 'oyster' ? OYSTER_HISTORY_URL : CONTACTLESS_HISTORY_URL;
}

/** A payment card the harvest script found linked on a TfL page. */
export type CardEntry = { href: string; label?: string; expired?: boolean };

/** Wrong-page recoveries before giving up — guards against redirect loops. */
export const MAX_STEERS = 4;

/**
 * Most card history pages visited in one refresh. This is a runaway guard, not
 * a product limit: cards are de-duplicated by card number before they queue
 * (TfL lists the same PAN several times), so a real account with a handful of
 * cards never comes near it. If it ever does bite, `cardsDropped` records how
 * many were skipped and the closing message says so — a cap that truncates
 * silently would read as "we checked everything" when it hadn't.
 */
export const MAX_CARDS = 20;

interface Live {
  /** Wrong-page steers used so far (capped at MAX_STEERS). */
  steers: number;
  /** History/card pages still to visit. */
  queue: string[];
  /** Pages already steered to — never re-queued. */
  visited: string[];
  /** Journeys imported so far across all pages. */
  inserted: number;
  /** Whether any journey data (csv/rows) has been seen yet. */
  harvested: boolean;
  /** Where wrong pages get steered to — the mode's primary history page. */
  home: string;
  /** Whether to attempt the direct CSV fetch after the queue is exhausted
   * (TfL-15/18 — in place on the current page; the statements page is gone).
   * False for Oyster-only mode (no statements endpoint). */
  directCsv: boolean;
  /** True once the classic history queue has been exhausted and advance() has
   * moved on to the direct CSV attempt. Used by direct-failed to decide
   * whether the history page has already been swept (return done/no-history)
   * or not (steer back to home as a fallback). */
  historySwept: boolean;
  /** True once the TfL-17 in-place direct attempt has run on the contactless
   * Dashboard — one shot per refresh; later Dashboard landings park normally. */
  directTried: boolean;
  /** Cards the MAX_CARDS guard refused to queue. Surfaced in the closing
   * message — see MAX_CARDS on why this is never allowed to be silent. */
  cardsDropped: number;
}

export type FlowState =
  | ({ phase: 'loading' } & Live)
  | ({ phase: 'signed-out' } & Live)
  | ({ phase: 'challenge' } & Live)
  | ({ phase: 'consent' } & Live)
  | ({ phase: 'account-dashboard' } & Live)
  | ({ phase: 'steering'; target: string } & Live)
  | ({ phase: 'harvesting' } & Live)
  | ({ phase: 'importing' } & Live)
  | { phase: 'done'; message: string; inserted: number }
  | { phase: 'cancelled' }
  | { phase: 'error'; message: string };

export type FlowEvent =
  | { type: 'nav'; url: string; title?: string }
  | { type: 'loaded'; url: string }
  | {
      type: 'harvest';
      status: 'signed-out' | 'challenge' | 'consent' | 'wrong-page' | 'cards' | 'csv' | 'rows' | 'empty' | 'error';
      message?: string;
      cards?: CardEntry[];
    }
  | { type: 'handover' }
  | { type: 'direct-failed'; url?: string }
  | { type: 'imported'; inserted: number }
  | { type: 'import-failed'; message: string }
  | { type: 'web-error'; message: string }
  | { type: 'cancel' };

/** Flow start for a mode: first history page loads, the rest queue up. */
export function makeInitialFlow(mode: FetchMode): FlowState {
  const [home, ...rest] = historyUrlsFor(mode);
  return { phase: 'loading', steers: 0, queue: rest, visited: [], inserted: 0, harvested: false, home, directCsv: mode !== 'oyster', historySwept: false, directTried: false, cardsDropped: 0 };
}

export const INITIAL_FLOW: FlowState = makeInitialFlow('contactless');

export function isTerminal(s: FlowState): boolean {
  return s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'error';
}

/**
 * Paused = the page belongs to the user. While paused the machine ignores
 * loads, navigations and stale harvest reports — the component keys ALL
 * injection and steering off phases this predicate excludes, so pausing IS
 * the no-injection guarantee. Only 'handover' (the Continue button) resumes.
 */
export function isPaused(s: FlowState): boolean {
  return s.phase === 'signed-out' || s.phase === 'challenge' || s.phase === 'consent'
    || s.phase === 'account-dashboard';
}

/** Whether the Continue button applies: any live phase except a running import. */
export function canHandover(s: FlowState): boolean {
  return !isTerminal(s) && s.phase !== 'importing';
}

/** Actual sign-in pages only — path contains signin/sign-in/login. */
export function isLoginUrl(url: string): boolean {
  return /signin|sign-in|login/i.test(url);
}

/**
 * TfL's cookie-consent interstitial (TfL-25).
 *
 * This is the page that made the refresh unusable, and the failure was the
 * machine's, not the WebView's: an unrecognised page reports 'wrong-page', and
 * the answer to wrong-page is to set window.location back to the history URL.
 * So the consent page loaded, was classified as a dud, and got navigated out
 * from under the user about a second later — tap "Accept all cookies" and the
 * page is already reloading, banner intact. Four rounds of that and the
 * refresh gave up with "kept landing away from the journey history page".
 *
 * The fix is to recognise it and PAUSE, which is the same guarantee TfL-13
 * gives login and robot-check pages: paused means no steering and no
 * injection, so the page is wholly the user's until they tap Continue.
 *
 * Matching on 'cookie'/'consent' anywhere in the URL is deliberately broad.
 * TfL is not going to serve journey data from a URL with "cookie" in it, and
 * the cost of a false positive is one extra Continue tap, while the cost of a
 * false negative is the bug above. Checked AFTER isLoginUrl so an OIDC
 * sign-in carrying a `consent` parameter still parks as signed-out.
 */
export function isConsentUrl(url: string): boolean {
  return /cookie|consent/i.test(url);
}

/**
 * TfL's own captcha gate (TfL-25). Verified live: an unauthenticated GET of
 * the contactless history page 302s to /UnregisteredCustomer/Captcha. That is
 * neither a login page nor a Cloudflare challenge, so before this it was a
 * 'wrong-page' too — meaning a brand-new user's very first refresh got steered
 * off TfL's captcha four times and then errored. Public-release blocker.
 */
export function isCaptchaUrl(url: string): boolean {
  return /captcha/i.test(url);
}

/**
 * TfL telling us, in a URL, that nobody is signed in. Distinct from
 * isLoginUrl: this is not the sign-in form, it's the gate in front of it.
 * Checked after isCaptchaUrl because the captcha path contains both.
 */
export function isUnregisteredUrl(url: string): boolean {
  return /unregisteredcustomer/i.test(url);
}

/**
 * The signed-in My Account dashboard — not a login page, but also not a
 * journey history page. TfL redirects here in two patterns: account.tfl.gov.uk
 * (after some flows) and contactless.tfl.gov.uk/Dashboard (post-login redirect
 * seen on device). The flow pauses and tells the user to navigate to their
 * contactless cards and tap Continue.
 */
export function isAccountDashboard(url: string): boolean {
  return (
    (/account\.tfl\.gov\.uk/i.test(url) && !isLoginUrl(url)) ||
    isContactlessDashboard(url)
  );
}

/**
 * The signed-in Dashboard on contactless.tfl.gov.uk specifically (TfL-17).
 * TfL redirects every steer here, but it's same-origin with the statements
 * endpoint — so instead of parking, the flow runs the direct CSV fetch right
 * on this page (once per refresh) before falling back to the user handover.
 */
export function isContactlessDashboard(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/Dashboard/i.test(url);
}

/**
 * Challenge detection from the page title the WebView reports on navigation —
 * catches Cloudflare-style robot checks WITHOUT injecting anything into the
 * page (TfL-13). Mirrors the harvest script's title check.
 */
export function isChallengeTitle(title: string): boolean {
  return /just a moment|attention required|verify you are human|are you a robot|security check/i.test(title);
}

export function doneMessage(inserted: number, cardsDropped = 0): string {
  const tail = cardsDropped > 0
    ? cardsDropped === 1
      ? " 1 further card wasn't checked — refresh again to pick it up."
      : ` ${cardsDropped} further cards weren't checked — refresh again to pick them up.`
    : '';
  // "Already up to date" is a claim, and with cards left unchecked it would be
  // a false one — so it isn't made.
  if (inserted <= 0) {
    return cardsDropped > 0 ? `No new journeys on the cards checked.${tail}` : "No new journeys — you're already up to date.";
  }
  return `Imported ${inserted} new journey${inserted === 1 ? '' : 's'} from TfL.${tail}`;
}

const liveOf = (s: FlowState): Live => ({
  steers: 'steers' in s ? s.steers : 0,
  queue: 'queue' in s ? s.queue : [],
  visited: 'visited' in s ? s.visited : [],
  inserted: 'inserted' in s ? s.inserted : 0,
  harvested: 'harvested' in s ? s.harvested : false,
  home: 'home' in s ? s.home : CONTACTLESS_HISTORY_URL,
  directCsv: 'directCsv' in s ? s.directCsv : false,
  historySwept: 'historySwept' in s ? s.historySwept : false,
  directTried: 'directTried' in s ? s.directTried : false,
  cardsDropped: 'cardsDropped' in s ? s.cardsDropped : 0,
});

/**
 * Done with the current page: steer to the next queued page; if the queue is
 * exhausted, run the direct CSV fetch in place on whatever page is showing
 * (TfL-18 — the statements page is gone, but the download endpoint is
 * same-origin from any contactless page); or finish. The no-history verdict
 * can only be reached here off the back of a confirmed history-page 'empty'
 * with nothing left to visit — never from the dashboard or any intermediate
 * page.
 */
function advance(l: Live): FlowState {
  const [next, ...rest] = l.queue;
  if (next) return { ...l, phase: 'steering', target: next, queue: rest, visited: [...l.visited, next] };
  if (l.directCsv) return { ...l, phase: 'harvesting', directCsv: false, directTried: true, historySwept: true };
  if (l.harvested) return { phase: 'done', message: doneMessage(l.inserted, l.cardsDropped), inserted: l.inserted };
  return { phase: 'done', message: 'No journey history found on TfL.', inserted: 0 };
}

/**
 * Add the cards a page listed to the visit queue: unexpired entries first;
 * if every entry is expired-flagged (TfL's flags are unreliable — Luke's live
 * card shows as expired) all of them qualify. Already-visited and already-queued
 * links never re-enter, and the total visit count is capped — with any overflow
 * counted rather than dropped quietly.
 *
 * Identity is the LINK, not the card number, and that is a deliberate reversal
 * (TfL-25). Luke's account lists "Visa ending in 5006" twice, so keying on the
 * PAN tail looked like the obvious saving — one page load instead of two.
 * The tests below say otherwise: with three •5006 entries, only the SECOND
 * one's page has journeys on it. Collapsing them by card number would have
 * visited the first, found it empty, and reported "you're already up to date"
 * while a page of real journeys sat unread — a missed refund, silently. An
 * extra page load costs a couple of seconds; a dropped card costs money. The
 * duplicates are handled by MAX_CARDS instead, which bounds the cost without
 * ever choosing which card to skip.
 */
function enqueueCards(l: Live, cards: CardEntry[] | undefined): { queue: string[]; cardsDropped: number } {
  const entries = (cards ?? []).filter(c => c && typeof c.href === 'string' && c.href !== '');
  const usable = entries.some(c => !c.expired) ? entries.filter(c => !c.expired) : entries;
  const seen = new Set([...l.visited, ...l.queue]);
  const queue = [...l.queue];
  let cardsDropped = l.cardsDropped;
  for (const c of usable) {
    if (seen.has(c.href)) continue;
    if (l.visited.length + queue.length >= MAX_CARDS) { cardsDropped++; continue; }
    seen.add(c.href);
    queue.push(c.href);
  }
  return { queue, cardsDropped };
}

export function reduceFlow(s: FlowState, e: FlowEvent): FlowState {
  if (isTerminal(s)) return s; // terminal states absorb everything
  const l = liveOf(s);
  switch (e.type) {
    case 'cancel':
      return { phase: 'cancelled' };
    case 'handover':
      // Continue button: harvest whatever page is showing, right now. Works
      // from paused states (the headline resume) and from any stalled live
      // phase (the escape hatch) — but never interrupts a running import.
      if (s.phase === 'importing') return s;
      return { ...l, phase: 'harvesting' };
    case 'web-error':
      // While the user drives (login/challenge), a failed page is theirs to
      // retry — it must not kill the refresh out from under them.
      if (isPaused(s)) return s;
      return { phase: 'error', message: e.message };
    case 'nav':
      if (isPaused(s)) return s; // user browsing freely — stay out of the way
      // Robot check spotted from the reported page title — no injection needed.
      if (e.title != null && isChallengeTitle(e.title)) return { ...l, phase: 'challenge' };
      // An expired session redirects to the account sign-in mid-navigation.
      if (isLoginUrl(e.url)) return { ...l, phase: 'signed-out' };
      // TfL-25: consent and captcha gates are the user's, exactly like login.
      // Caught on 'nav' as well as 'loaded' so the pause lands before the
      // steering that used to yank the page away mid-tap.
      if (isConsentUrl(e.url)) return { ...l, phase: 'consent' };
      if (isCaptchaUrl(e.url)) return { ...l, phase: 'challenge' };
      if (isUnregisteredUrl(e.url)) return { ...l, phase: 'signed-out' };
      // TfL-17: the contactless Dashboard gets a direct attempt on 'loaded' —
      // don't park on the mid-navigation event (parking blocks injection).
      if (isContactlessDashboard(e.url) && l.directCsv && !l.directTried) return s;
      // TfL redirects to the My Account dashboard (account.tfl.gov.uk) when
      // the session is unestablished on contactless.tfl.gov.uk (TfL-15).
      if (isAccountDashboard(e.url)) return { ...l, phase: 'account-dashboard' };
      return s;
    case 'loaded':
      // Paused: pages load while the user solves/signs in — none of them are
      // ours to touch. No harvesting transition means no injection (TfL-13);
      // the flow resumes only via handover.
      if (isPaused(s)) return s;
      if (isLoginUrl(e.url)) return { ...l, phase: 'signed-out' };
      // TfL-25: same three gates as the 'nav' case. Pausing here is what stops
      // the harvest being injected into a consent or captcha page at all.
      if (isConsentUrl(e.url)) return { ...l, phase: 'consent' };
      if (isCaptchaUrl(e.url)) return { ...l, phase: 'challenge' };
      if (isUnregisteredUrl(e.url)) return { ...l, phase: 'signed-out' };
      // TfL-17: signed-in contactless Dashboard — TfL bounces every steer
      // here, so run the direct CSV fetch in place instead of parking. One
      // shot per refresh; directCsv clears so a success advances to done (or
      // Oyster) rather than steering to the statements page TfL won't serve.
      if (isContactlessDashboard(e.url) && l.directCsv && !l.directTried) {
        return { ...l, phase: 'harvesting', directTried: true, directCsv: false };
      }
      if (isAccountDashboard(e.url)) return { ...l, phase: 'account-dashboard' };
      if (s.phase === 'importing') return s; // import already under way
      // Harvest every landed page — the script itself tells the flow whether
      // it's a challenge, a wrong page, a card picker or the history.
      // On the statements page specifically, clear directCsv so that a
      // successful harvest → import → advance goes to done rather than
      // re-steering back here (TfL-14/15).
      if (/\/newstatements(\?|$)/i.test(e.url)) return { ...l, phase: 'harvesting', directCsv: false };
      return { ...l, phase: 'harvesting' };
    case 'direct-failed':
      // The direct CSV fetch on the statements page failed (TfL-15).
      if (s.phase !== 'harvesting') return s;
      // TfL-17: failed while sitting on the contactless Dashboard — steering
      // just bounces back here, so park and let the user navigate + Continue.
      if (e.url != null && isContactlessDashboard(e.url)) return { ...l, phase: 'account-dashboard' };
      if (l.steers >= MAX_STEERS) return { phase: 'error', message: 'kept landing away from the journey history page' };
      // If the classic history queue was already exhausted before we reached
      // this page (historySwept), just advance — whatever history sweep data
      // stands. Otherwise steer to the home page as a fallback so the classic
      // harvest can run (fresh-start path where statements is visited first).
      if (l.historySwept) return advance({ ...l, directCsv: false });
      return { ...l, phase: 'steering', target: l.home, steers: l.steers + 1, directCsv: false };
    case 'harvest':
      // Reports only count while a harvest is running: injection only happens
      // in 'harvesting', so anything else is a stale duplicate — and while
      // paused a late report must never yank the page from the user.
      if (s.phase !== 'harvesting') return s;
      if (e.status === 'signed-out') return { ...l, phase: 'signed-out' };
      if (e.status === 'challenge') return { ...l, phase: 'challenge' };
      // TfL-25: the DOM half of consent detection, for the cookie wall served
      // at the requested URL. It catches the case a URL check can't and the
      // more damaging one: on the history URL itself, a cookie wall used to be
      // reported as 'empty' — "no journeys" from a page whose data was merely
      // withheld. The script only reports this when the page rendered no
      // journey table, so a banner over real data still harvests.
      if (e.status === 'consent') return { ...l, phase: 'consent' };
      if (e.status === 'wrong-page') {
        if (l.queue.length) return advance(l); // pages still waiting — skip this dud
        if (l.steers >= MAX_STEERS) return { phase: 'error', message: 'kept landing away from the journey history page' };
        return { ...l, phase: 'steering', target: l.home, steers: l.steers + 1 };
      }
      if (e.status === 'cards') {
        const { queue, cardsDropped } = enqueueCards(l, e.cards);
        if (queue.length) return advance({ ...l, queue, cardsDropped });
        if (l.harvested) return { phase: 'done', message: doneMessage(l.inserted, cardsDropped), inserted: l.inserted };
        return { phase: 'error', message: 'no card with journey history found' };
      }
      if (e.status === 'empty') return advance(l); // confirmed history page, no data
      if (e.status === 'error') return { phase: 'error', message: e.message ?? 'harvest failed' };
      // csv/rows: import it; other cards the page listed queue up behind.
      return { ...l, phase: 'importing', harvested: true, ...enqueueCards(l, e.cards) };
    case 'imported':
      if (s.phase !== 'importing') return s;
      return advance({ ...l, inserted: l.inserted + e.inserted });
    case 'import-failed':
      return { phase: 'error', message: e.message };
  }
}

/** Status-bar line for each phase — the narration Luke asked for. */
export function statusText(s: FlowState): string {
  switch (s.phase) {
    case 'loading': return 'Loading TfL…';
    case 'signed-out': return 'Sign in to your TfL account, then tap Continue.';
    case 'challenge': return "Complete TfL's security check, then tap Continue.";
    // TfL-25: cookie choices are the user's to make — never auto-clicked, and
    // never described as a step we could have done for them.
    case 'consent': return 'Choose your TfL cookie settings, then tap Continue.';
    // TfL-25 (Luke, 29-Jul): this used to say "Navigate to 'My contactless
    // cards' on TfL, then tap Continue" — an instruction that was simply
    // untrue. Continue dispatches 'handover', which harvests whatever page is
    // showing; on the dashboard that harvest reports 'cards', queues each
    // card's history page and drives itself there. The user never had to
    // navigate. Asking them to do work the machine already does reads as the
    // machine not working.
    case 'account-dashboard': return "Signed in. Tap Continue and I'll find your cards.";
    case 'steering': return 'Opening your journey history…';
    case 'harvesting': return 'Reading your journey history…';
    case 'importing': return 'Importing journeys…';
    case 'done': return s.message;
    case 'cancelled': return 'Refresh cancelled.';
    case 'error': return `Couldn't refresh — ${s.message}`;
  }
}

/** What a progress bar can honestly show — see progressOf. */
export interface Progress {
  /** Pages finished. */
  done: number;
  /** Pages finished + still to go. Can GROW mid-refresh; see below. */
  total: number;
  /** 0..1, for a determinate bar. */
  fraction: number;
  /** Human label, e.g. "Page 2 of 5". */
  label: string;
}

/**
 * Progress for the refresh (Luke, 29-Jul: "it needs a progress bar or
 * something").
 *
 * Two honest limits, both deliberate:
 *
 * `total` grows. We only know how many pages there are once TfL's card list has
 * been harvested, so "Page 2 of 3" can become "Page 2 of 7" when a five-card
 * account reveals itself. A bar that jumps backwards is mildly annoying; a bar
 * that reaches 100% and then keeps working is a lie, and the whole point of the
 * bar is to tell the user the thing is alive.
 *
 * Returns null while paused or terminal — during a pause the machine is doing
 * nothing at all, so a bar would be claiming work that isn't happening, and the
 * status line already says whose turn it is. Callers should render an
 * indeterminate spinner (or nothing) on null rather than a 0% bar.
 */
export function progressOf(s: FlowState): Progress | null {
  if (isTerminal(s) || isPaused(s)) return null;
  const l = s as FlowState & Live;
  // `visited` is appended at the moment a page is steered TO, so it includes
  // the page in flight and excludes the mode's own first history page, which
  // was never steered to. Counting pages STARTED (that first page, plus every
  // steer) and treating the current one as unfinished is what makes the label
  // match what the user is looking at.
  const started = 1 + l.visited.length;
  const remaining = l.queue.length + (l.directCsv && !l.directTried ? 1 : 0);
  const total = started + remaining;
  const done = started - 1;
  return { done, total, fraction: done / total, label: `Page ${started} of ${total}` };
}
