// TfL-OVERCHARGE-AUTO: URL heuristics for the "Complete my journey" wizard.
import {
  incompleteJourneysUrl,
  isCompleteJourneyConfirmPage,
  isCompleteJourneyFormPage,
} from '../claims/complete-journey-fill';

describe('isCompleteJourneyFormPage', () => {
  it('matches CompleteMyJourney path', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/CompleteMyJourney')).toBe(true);
  });

  it('matches Complete-my-journey with hyphen and query string', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/Complete-my-journey?id=1')).toBe(true);
  });

  it('matches IncompleteJourney (singular) in path', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/MyCards/999/IncompleteJourney/Fill')).toBe(true);
  });

  it('does not match CorrectJourney path (regex removed — too broad)', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/CorrectJourney')).toBe(false);
  });

  it('matches ApplyForRefund with both cardDisplayId and journeyDisplayId params', () => {
    expect(isCompleteJourneyFormPage(
      'https://contactless.tfl.gov.uk/Refunds/ApplyForRefund?cardDisplayId=1234&journeyDisplayId=5678',
    )).toBe(true);
  });

  it('does not match ApplyForRefund without query params (list page)', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/Refunds/ApplyForRefund')).toBe(false);
  });

  it('does not match ApplyForRefund with only cardDisplayId', () => {
    expect(isCompleteJourneyFormPage(
      'https://contactless.tfl.gov.uk/Refunds/ApplyForRefund?cardDisplayId=1234',
    )).toBe(false);
  });

  it('does not match the incomplete journeys LIST page (plural)', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/MyCards/123/IncompleteJourneys')).toBe(false);
  });

  it('does not match Dashboard', () => {
    expect(isCompleteJourneyFormPage('https://contactless.tfl.gov.uk/Dashboard')).toBe(false);
  });

  it('does not match wrong domain', () => {
    expect(isCompleteJourneyFormPage('https://www.tfl.gov.uk/CompleteMyJourney')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCompleteJourneyFormPage('')).toBe(false);
  });
});

describe('isCompleteJourneyConfirmPage', () => {
  it('matches /Confirm suffix', () => {
    expect(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/CompleteMyJourney/Confirm')).toBe(true);
  });

  it('matches /Success path', () => {
    expect(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/Success?ref=abc')).toBe(true);
  });

  it('matches /ThankYou path', () => {
    expect(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/ThankYou')).toBe(true);
  });

  it('does not match the form page', () => {
    expect(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/CompleteMyJourney')).toBe(false);
  });

  it('does not match MyCards', () => {
    expect(isCompleteJourneyConfirmPage('https://contactless.tfl.gov.uk/MyCards')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCompleteJourneyConfirmPage('')).toBe(false);
  });
});

describe('incompleteJourneysUrl', () => {
  it('builds the URL with the card ID in the path', () => {
    expect(incompleteJourneysUrl('1234567890'))
      .toBe('https://contactless.tfl.gov.uk/MyCards/1234567890/IncompleteJourneys');
  });

  it('percent-encodes spaces in the card ID', () => {
    expect(incompleteJourneysUrl('test card'))
      .toBe('https://contactless.tfl.gov.uk/MyCards/test%20card/IncompleteJourneys');
  });
});
