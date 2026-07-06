// Visible-refresh flow state machine (TfL-11). Pure module — node-testable.
//
// TfL-10's hidden WebView gave no on-device feedback, so the refresh now runs
// inside a visible sheet showing the real TfL pages. This reducer owns the
// flow: what the status bar says, when the harvest script gets injected, and
// when the sheet is finished. The harvest script, parser and dedupe are
// TfL-10's, unchanged — this module is presentation + interruption handling.
//
// Signed-out is not a failure here: the login page is simply shown for the
// user to sign in, and the flow continues on the next page load.

export type FlowState =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'harvesting' }
  | { phase: 'importing' }
  | { phase: 'done'; message: string; inserted: number }
  | { phase: 'cancelled' }
  | { phase: 'error'; message: string };

export type FlowEvent =
  | { type: 'nav'; url: string }
  | { type: 'loaded'; url: string }
  | { type: 'harvest'; status: 'signed-out' | 'csv' | 'rows' | 'empty' | 'error'; message?: string }
  | { type: 'imported'; inserted: number }
  | { type: 'import-failed'; message: string }
  | { type: 'web-error'; message: string }
  | { type: 'cancel' };

export const INITIAL_FLOW: FlowState = { phase: 'loading' };

export function isTerminal(s: FlowState): boolean {
  return s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'error';
}

export function isLoginUrl(url: string): boolean {
  return /signin|sign-in|login|account\.tfl\.gov\.uk/i.test(url);
}

export function isHistoryUrl(url: string): boolean {
  return url.toLowerCase().includes('7dayhistory');
}

export function doneMessage(inserted: number): string {
  if (inserted <= 0) return 'No new journeys — you’re already up to date.';
  return `Imported ${inserted} new journey${inserted === 1 ? '' : 's'} from TfL.`;
}

export function reduceFlow(s: FlowState, e: FlowEvent): FlowState {
  if (isTerminal(s)) return s; // terminal states absorb everything
  switch (e.type) {
    case 'cancel':
      return { phase: 'cancelled' };
    case 'web-error':
      return { phase: 'error', message: e.message };
    case 'nav':
      // An expired session redirects to the account sign-in mid-navigation.
      return isLoginUrl(e.url) ? { phase: 'signed-out' } : s;
    case 'loaded':
      if (isLoginUrl(e.url)) return { phase: 'signed-out' };
      if (s.phase === 'importing') return s; // import already under way
      return { phase: 'harvesting' };
    case 'harvest':
      if (e.status === 'signed-out') return { phase: 'signed-out' };
      // Data/empty/error reports only count while a harvest is running — a
      // late duplicate message must not restart or double the import.
      if (s.phase !== 'harvesting') return s;
      if (e.status === 'empty') return { phase: 'done', message: 'No journey history found on TfL.', inserted: 0 };
      if (e.status === 'error') return { phase: 'error', message: e.message ?? 'harvest failed' };
      return { phase: 'importing' };
    case 'imported':
      return { phase: 'done', message: doneMessage(e.inserted), inserted: e.inserted };
    case 'import-failed':
      return { phase: 'error', message: e.message };
  }
}

/**
 * What the sheet should do when a page finishes loading, decided BEFORE the
 * loaded event is reduced:
 *   'inject'      — run the harvest script on this page
 *   'go-history'  — post-login landing page isn't the journey history; steer
 *                   the WebView there instead of harvesting the wrong page
 *   'none'        — login page (the user is using it) or flow already over
 */
export function loadAction(s: FlowState, url: string): 'inject' | 'go-history' | 'none' {
  if (isTerminal(s) || s.phase === 'importing') return 'none';
  if (isLoginUrl(url)) return 'none';
  if (s.phase === 'signed-out' && !isHistoryUrl(url)) return 'go-history';
  return 'inject';
}

/** Status-bar line for each phase — the narration Luke asked for. */
export function statusText(s: FlowState): string {
  switch (s.phase) {
    case 'loading': return 'Loading TfL…';
    case 'signed-out': return 'Sign in to your TfL account — the refresh continues automatically after you sign in.';
    case 'harvesting': return 'Reading your journey history…';
    case 'importing': return 'Importing journeys…';
    case 'done': return s.message;
    case 'cancelled': return 'Refresh cancelled.';
    case 'error': return `Couldn’t refresh — ${s.message}`;
  }
}
