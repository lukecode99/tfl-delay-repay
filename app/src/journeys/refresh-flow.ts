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

/** A payment card the harvest script found linked on a TfL page. */
export type CardEntry = { href: string; label?: string; expired?: boolean };

/** Wrong-page recoveries before giving up — guards against redirect loops. */
export const MAX_STEERS = 4;

/** Most card history pages visited in one refresh. */
export const MAX_CARDS = 8;

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
}

export type FlowState =
  | ({ phase: 'loading' } & Live)
  | ({ phase: 'signed-out' } & Live)
  | ({ phase: 'challenge' } & Live)
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
      status: 'signed-out' | 'challenge' | 'wrong-page' | 'cards' | 'csv' | 'rows' | 'empty' | 'error';
      message?: string;
      cards?: CardEntry[];
    }
  | { type: 'handover' }
  | { type: 'imported'; inserted: number }
  | { type: 'import-failed'; message: string }
  | { type: 'web-error'; message: string }
  | { type: 'cancel' };

/** Flow start for a mode: first history page loads, the rest queue up. */
export function makeInitialFlow(mode: FetchMode): FlowState {
  const [home, ...rest] = historyUrlsFor(mode);
  return { phase: 'loading', steers: 0, queue: rest, visited: [], inserted: 0, harvested: false, home };
}

export const INITIAL_FLOW: FlowState = makeInitialFlow('contactless');

export function isTerminal(s: FlowState): boolean {
  return s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'error';
}

/**
 * Paused = the page belongs to the user (login or robot check). While paused
 * the machine ignores loads, navigations and stale harvest reports — the
 * component keys ALL injection and steering off phases this predicate
 * excludes, so pausing IS the no-injection guarantee. Only 'handover'
 * (the Continue button) resumes.
 */
export function isPaused(s: FlowState): boolean {
  return s.phase === 'signed-out' || s.phase === 'challenge';
}

/** Whether the Continue button applies: any live phase except a running import. */
export function canHandover(s: FlowState): boolean {
  return !isTerminal(s) && s.phase !== 'importing';
}

/**
 * Actual sign-in pages only. The signed-in My Account dashboard also lives on
 * account.tfl.gov.uk, so matching the whole host would wrongly park the flow
 * there (TfL-12) — the account host is NOT a login marker.
 */
export function isLoginUrl(url: string): boolean {
  return /signin|sign-in|login/i.test(url);
}

/**
 * Challenge detection from the page title the WebView reports on navigation —
 * catches Cloudflare-style robot checks WITHOUT injecting anything into the
 * page (TfL-13). Mirrors the harvest script's title check.
 */
export function isChallengeTitle(title: string): boolean {
  return /just a moment|attention required|verify you are human|are you a robot|security check/i.test(title);
}

export function doneMessage(inserted: number): string {
  if (inserted <= 0) return 'No new journeys — you’re already up to date.';
  return `Imported ${inserted} new journey${inserted === 1 ? '' : 's'} from TfL.`;
}

const liveOf = (s: FlowState): Live => ({
  steers: 'steers' in s ? s.steers : 0,
  queue: 'queue' in s ? s.queue : [],
  visited: 'visited' in s ? s.visited : [],
  inserted: 'inserted' in s ? s.inserted : 0,
  harvested: 'harvested' in s ? s.harvested : false,
  home: 'home' in s ? s.home : CONTACTLESS_HISTORY_URL,
});

/**
 * Done with the current page: steer to the next queued page, or finish. The
 * no-history verdict can only be reached here off the back of a confirmed
 * history-page 'empty' with nothing left to visit — never from the dashboard
 * or any intermediate page.
 */
function advance(l: Live): FlowState {
  const [next, ...rest] = l.queue;
  if (next) return { ...l, phase: 'steering', target: next, queue: rest, visited: [...l.visited, next] };
  if (l.harvested) return { phase: 'done', message: doneMessage(l.inserted), inserted: l.inserted };
  return { phase: 'done', message: 'No journey history found on TfL.', inserted: 0 };
}

/**
 * Add the cards a page listed to the visit queue: unexpired entries first;
 * if every entry is expired-flagged (TfL's flags are unreliable — Luke's live
 * card shows as expired) all of them qualify. Already-visited and already-
 * queued pages never re-enter, and the total visit count is capped.
 */
function enqueueCards(l: Live, cards: CardEntry[] | undefined): string[] {
  const entries = (cards ?? []).filter(c => c && typeof c.href === 'string' && c.href !== '');
  const usable = entries.some(c => !c.expired) ? entries.filter(c => !c.expired) : entries;
  const seen = new Set([...l.visited, ...l.queue]);
  const queue = [...l.queue];
  for (const c of usable) {
    if (l.visited.length + queue.length >= MAX_CARDS) break;
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    queue.push(c.href);
  }
  return queue;
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
      return isLoginUrl(e.url) ? { ...l, phase: 'signed-out' } : s;
    case 'loaded':
      // Paused: pages load while the user solves/signs in — none of them are
      // ours to touch. No harvesting transition means no injection (TfL-13);
      // the flow resumes only via handover.
      if (isPaused(s)) return s;
      if (isLoginUrl(e.url)) return { ...l, phase: 'signed-out' };
      if (s.phase === 'importing') return s; // import already under way
      // Harvest every landed page — the script itself tells the flow whether
      // it's a challenge, a wrong page, a card picker or the history.
      return { ...l, phase: 'harvesting' };
    case 'harvest':
      // Reports only count while a harvest is running: injection only happens
      // in 'harvesting', so anything else is a stale duplicate — and while
      // paused a late report must never yank the page from the user.
      if (s.phase !== 'harvesting') return s;
      if (e.status === 'signed-out') return { ...l, phase: 'signed-out' };
      if (e.status === 'challenge') return { ...l, phase: 'challenge' };
      if (e.status === 'wrong-page') {
        if (l.queue.length) return advance(l); // pages still waiting — skip this dud
        if (l.steers >= MAX_STEERS) return { phase: 'error', message: 'kept landing away from the journey history page' };
        return { ...l, phase: 'steering', target: l.home, steers: l.steers + 1 };
      }
      if (e.status === 'cards') {
        const queue = enqueueCards(l, e.cards);
        if (queue.length) return advance({ ...l, queue });
        if (l.harvested) return { phase: 'done', message: doneMessage(l.inserted), inserted: l.inserted };
        return { phase: 'error', message: 'no card with journey history found' };
      }
      if (e.status === 'empty') return advance(l); // confirmed history page, no data
      if (e.status === 'error') return { phase: 'error', message: e.message ?? 'harvest failed' };
      // csv/rows: import it; other cards the page listed queue up behind.
      return { ...l, phase: 'importing', harvested: true, queue: enqueueCards(l, e.cards) };
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
    case 'challenge': return 'Complete TfL’s security check, then tap Continue.';
    case 'steering': return 'Opening your journey history…';
    case 'harvesting': return 'Reading your journey history…';
    case 'importing': return 'Importing journeys…';
    case 'done': return s.message;
    case 'cancelled': return 'Refresh cancelled.';
    case 'error': return `Couldn’t refresh — ${s.message}`;
  }
}
