// Overcharge correction steering (TfL-OVERCHARGE-CLAIM). Pure module — node-testable.
//
// The incomplete-journey / max-fare correction flow lives on contactless.tfl.gov.uk
// behind the user's signed-in session. After the OAuth login the site lands on the
// Dashboard; we steer straight to MyCards so the user can pick their card and
// navigate to "Incomplete journeys" or "Complete my journey" for the affected trip.
// Same post-login steering pattern as the delay-repay flow in ClaimWebScreen/TfL-22.

export const CONTACTLESS_CARDS_URL = 'https://contactless.tfl.gov.uk/MyCards';

/**
 * Returns a URL to navigate to when we're at `currentUrl` and need to steer
 * toward the incomplete-journey correction flow. Returns null if no steering
 * is required (already in the right place, or not a page we recognise).
 */
export function overchargeSteerUrl(currentUrl: string): string | null {
  if (/contactless\.tfl\.gov\.uk\/Dashboard/i.test(currentUrl)) {
    return CONTACTLESS_CARDS_URL;
  }
  return null;
}
