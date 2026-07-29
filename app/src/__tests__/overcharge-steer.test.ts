// Tests for overchargeSteerUrl — same pattern as the TfL-12/13 stub-DOM tests:
// pure function exercised directly without a WebView or real network.
import {
  overchargeSteerUrl,
  correctableJourneysUrl,
  isCorrectableJourneysPage,
  CONTACTLESS_CARDS_URL,
} from '../claims/overcharge-steer';

describe('correctableJourneysUrl', () => {
  it('builds the CorrectableJourneys URL with the card ID as a query param', () => {
    expect(correctableJourneysUrl('1234567890'))
      .toBe('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=1234567890');
  });

  it('percent-encodes special characters in the card ID', () => {
    expect(correctableJourneysUrl('abc def'))
      .toBe('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=abc%20def');
  });
});

describe('isCorrectableJourneysPage', () => {
  it('returns true for the CorrectableJourneys list URL', () => {
    expect(isCorrectableJourneysPage('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=123')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCorrectableJourneysPage('https://contactless.tfl.gov.uk/refunds/correctablejourneys')).toBe(true);
  });

  it('returns false for the ApplyForRefund form page', () => {
    expect(isCorrectableJourneysPage('https://contactless.tfl.gov.uk/Refunds/ApplyForRefund?journeyId=1')).toBe(false);
  });

  it('returns false for MyCards', () => {
    expect(isCorrectableJourneysPage('https://contactless.tfl.gov.uk/MyCards')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCorrectableJourneysPage('')).toBe(false);
  });
});

describe('overchargeSteerUrl', () => {
  // Legacy behaviour (no cardDisplayId) — Dashboard → MyCards
  it('steers from Dashboard to MyCards when no card ID is supplied', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Dashboard'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  it('is case-insensitive on the Dashboard segment', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/dashboard'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  it('matches Dashboard with a query string', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Dashboard?r=1'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  // New behaviour — Dashboard → CorrectableJourneys when cardDisplayId is known
  it('steers from Dashboard directly to CorrectableJourneys when cardDisplayId is supplied', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Dashboard', '9876'))
      .toBe('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=9876');
  });

  // MyCards fallback — only fires when cardDisplayId is known
  it('steers from MyCards to CorrectableJourneys when cardDisplayId is supplied', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/MyCards', '9876'))
      .toBe('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=9876');
  });

  it('does not steer from MyCards when cardDisplayId is absent', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/MyCards')).toBeNull();
  });

  // No steer on pages we don't need to redirect from
  it('returns null when already on CorrectableJourneys', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Refunds/CorrectableJourneys?cardDisplayId=1', '1')).toBeNull();
  });

  it('returns null for the sign-in page', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/SignIn')).toBeNull();
  });

  it('returns null for an unrelated URL', () => {
    expect(overchargeSteerUrl('https://www.tfl.gov.uk/')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(overchargeSteerUrl('')).toBeNull();
  });
});
