// Tests for overchargeSteerUrl — same pattern as the TfL-12/13 stub-DOM tests:
// pure function exercised directly without a WebView or real network.
import { overchargeSteerUrl, CONTACTLESS_CARDS_URL } from '../claims/overcharge-steer';

describe('overchargeSteerUrl', () => {
  it('steers from Dashboard to MyCards after login', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Dashboard'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  it('steers from Dashboard with trailing path', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/Dashboard?r=1'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  it('is case-insensitive on the Dashboard segment', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/dashboard'))
      .toBe(CONTACTLESS_CARDS_URL);
  });

  it('returns null when already on MyCards', () => {
    expect(overchargeSteerUrl('https://contactless.tfl.gov.uk/MyCards')).toBeNull();
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
