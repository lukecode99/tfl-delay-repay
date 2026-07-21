// Tests for TfL-ALERT-START: disruption notification formatter.
// Dates: 2026-07-21 in BST (UTC+1). span.from = 06:42Z = 07:42 BST.
// now = 07:14Z = 08:14 BST, 32 min after span start.
import { formatDisruptionAlert, formatElapsed } from '../notifications/disruption-format';

const BASE_SPAN = {
  lineName: 'Central',
  description: 'Severe delays',
  from: '2026-07-21T06:42:00.000Z', // 07:42 BST
  reason: 'signal failure at Leytonstone',
};

const NOW_08_14 = new Date('2026-07-21T07:14:00.000Z'); // 08:14 BST

describe('formatElapsed', () => {
  it('returns "N min ago" for under an hour', () => {
    expect(formatElapsed(0, 32 * 60_000)).toBe('32 min ago');
  });

  it('returns "N h ago" for exact hours', () => {
    expect(formatElapsed(0, 2 * 60 * 60_000)).toBe('2 h ago');
  });

  it('returns "N h M min ago" for mixed duration', () => {
    expect(formatElapsed(0, (60 + 19) * 60_000)).toBe('1 h 19 min ago');
  });

  it('returns "0 min ago" for zero elapsed', () => {
    expect(formatElapsed(1000, 1000)).toBe('0 min ago');
  });
});

describe('formatDisruptionAlert — title', () => {
  it('formats as "{lineName} line: {description}"', () => {
    const { title } = formatDisruptionAlert(BASE_SPAN, NOW_08_14);
    expect(title).toBe('Central line: Severe delays');
  });
});

describe('formatDisruptionAlert — body within 24 h', () => {
  it('uses London BST start time', () => {
    const { body } = formatDisruptionAlert(BASE_SPAN, NOW_08_14);
    expect(body).toMatch(/Started 07:42/);
  });

  it('includes 32 min elapsed', () => {
    const { body } = formatDisruptionAlert(BASE_SPAN, NOW_08_14);
    expect(body).toContain('32 min ago');
  });

  it('includes reason after em-dash', () => {
    const { body } = formatDisruptionAlert(BASE_SPAN, NOW_08_14);
    expect(body).toContain('— signal failure at Leytonstone');
  });

  it('ends with Delay Repay claim nudge', () => {
    const { body } = formatDisruptionAlert(BASE_SPAN, NOW_08_14);
    expect(body).toContain('Journeys during this disruption may qualify for Delay Repay.');
  });

  it('omits em-dash when reason is null', () => {
    const { body } = formatDisruptionAlert({ ...BASE_SPAN, reason: null }, NOW_08_14);
    expect(body).not.toContain('—');
    expect(body).toContain('Delay Repay');
  });
});

describe('formatDisruptionAlert — body over 24 h', () => {
  // span started 2026-07-19 06:42Z (Sun 07:42 BST), now is 2026-07-21 07:14Z
  const OLD_FROM = '2026-07-19T06:42:00.000Z';

  it('uses "since ddd HH:MM" format', () => {
    const { body } = formatDisruptionAlert({ ...BASE_SPAN, from: OLD_FROM }, NOW_08_14);
    expect(body).toMatch(/Started since Sun 07:42/);
  });

  it('still includes elapsed and claim nudge', () => {
    const { body } = formatDisruptionAlert({ ...BASE_SPAN, from: OLD_FROM }, NOW_08_14);
    expect(body).toContain('ago');
    expect(body).toContain('Delay Repay');
  });
});
