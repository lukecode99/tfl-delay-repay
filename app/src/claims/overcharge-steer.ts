// Overcharge correction steering (TfL-OVERCHARGE-CLAIM / TfL-OVERCHARGE-NAV).
// Pure module — node-testable.
//
// The incomplete-journey / max-fare correction flow lives on contactless.tfl.gov.uk
// behind the user's signed-in session. After OAuth login TfL lands on Dashboard;
// we steer directly to the CorrectableJourneys list for the specific card so the
// nav scanner can match the target journey and navigate to ApplyForRefund.
// Same post-login steering pattern as the delay-repay flow in ClaimWebScreen.

export const CONTACTLESS_CARDS_URL = 'https://contactless.tfl.gov.uk/MyCards';

/** Builds the CorrectableJourneys list URL for a given card. */
export function correctableJourneysUrl(cardDisplayId: string): string {
  return `https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=${encodeURIComponent(cardDisplayId)}`;
}

/** Returns true when the WebView is on the CorrectableJourneys list page. */
export function isCorrectableJourneysPage(url: string): boolean {
  return /contactless\.tfl\.gov\.uk\/Refunds\/CorrectableJourneys/i.test(url);
}

/**
 * Returns a URL to navigate to when we're at `currentUrl` and need to steer
 * toward the incomplete-journey correction flow. Returns null if no steering
 * is required (already in the right place, or not a page we recognise).
 *
 * When `cardDisplayId` is supplied the steer goes directly to the
 * CorrectableJourneys list rather than stopping at MyCards.
 */
export function overchargeSteerUrl(currentUrl: string, cardDisplayId?: string): string | null {
  // Post-OAuth landing page: steer directly to the refund list (or MyCards
  // if we don't know the card yet).
  if (/contactless\.tfl\.gov\.uk\/Dashboard/i.test(currentUrl)) {
    return cardDisplayId ? correctableJourneysUrl(cardDisplayId) : CONTACTLESS_CARDS_URL;
  }
  // Fallback: TfL sometimes lands on MyCards after a session restore.
  // Skip straight to CorrectableJourneys if we know the card.
  if (cardDisplayId && /contactless\.tfl\.gov\.uk\/MyCards($|[/?#])/i.test(currentUrl)) {
    return correctableJourneysUrl(cardDisplayId);
  }
  return null;
}
