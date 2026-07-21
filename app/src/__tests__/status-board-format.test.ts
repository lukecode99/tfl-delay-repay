// Tests for TfL-STATUS-BOARD: pure status board formatter.
import {
  hasCoverage,
  worstActiveSpan,
  countJourneyOverlaps,
  buildTimeline,
  formatElapsedShort,
  formatSinceLabel,
  buildStatusBoard,
  type LineCatalogEntry,
} from '../disruptions/status-board-format';
import type { LedgerSnapshot, DisruptionSpan, CoverageRange } from '../eligibility/ledger-json';

// 2026-07-21 08:14 BST = 07:14Z
const NOW = new Date('2026-07-21T07:14:00.000Z');

const SPAN_CENTRAL: DisruptionSpan = {
  line: 'central',
  lineName: 'Central',
  from: '2026-07-21T06:42:00.000Z',   // 07:42 BST
  to:   '2026-07-21T08:00:00.000Z',   // 09:00 BST (active: to >= now − 30 min)
  severity: 6,
  description: 'Severe delays',
  reason: 'signal failure at Leytonstone',
};

const COVERAGE: CoverageRange[] = [
  { from: '2026-07-21T04:00:00.000Z', to: '2026-07-21T07:30:00.000Z', polls: 20 },
];

const SNAPSHOT: LedgerSnapshot = {
  generatedAt: '2026-07-21T07:14:00.000Z',
  sinceISO: '2026-07-21T00:00:00.000Z',
  coverage: COVERAGE,
  spans: [SPAN_CENTRAL],
};

const CATALOG: LineCatalogEntry[] = [
  { id: 'central', name: 'Central', color: '#E32017' },
  { id: 'jubilee', name: 'Jubilee', color: '#A0A5A9' },
];

// --- hasCoverage ---

describe('hasCoverage', () => {
  it('returns true when a coverage range ends recently', () => {
    expect(hasCoverage(COVERAGE, NOW)).toBe(true);
  });

  it('returns false when latest coverage is older than the window', () => {
    const stale: CoverageRange[] = [
      { from: '2026-07-20T00:00:00.000Z', to: '2026-07-20T06:00:00.000Z', polls: 5 },
    ];
    expect(hasCoverage(stale, NOW)).toBe(false);
  });

  it('returns false for empty coverage', () => {
    expect(hasCoverage([], NOW)).toBe(false);
  });
});

// --- worstActiveSpan ---

describe('worstActiveSpan', () => {
  it('returns the central span when it is active', () => {
    const span = worstActiveSpan([SPAN_CENTRAL], 'central', NOW);
    expect(span).not.toBeNull();
    expect(span?.severity).toBe(6);
  });

  it('returns null for a line with no spans', () => {
    expect(worstActiveSpan([SPAN_CENTRAL], 'jubilee', NOW)).toBeNull();
  });

  it('returns null for a span that ended more than 30 min ago', () => {
    const expired: DisruptionSpan = {
      ...SPAN_CENTRAL,
      to: '2026-07-21T06:40:00.000Z', // ended 34 min before NOW
    };
    expect(worstActiveSpan([expired], 'central', NOW)).toBeNull();
  });

  it('returns worst (lowest severity) when multiple spans are active', () => {
    const minor: DisruptionSpan = { ...SPAN_CENTRAL, severity: 9, description: 'Minor delays' };
    const severe: DisruptionSpan = { ...SPAN_CENTRAL, severity: 6, description: 'Severe delays' };
    const result = worstActiveSpan([minor, severe], 'central', NOW);
    expect(result?.severity).toBe(6);
  });
});

// --- countJourneyOverlaps ---

describe('countJourneyOverlaps', () => {
  // SPAN_CENTRAL: 07:42 BST → 09:00 BST

  it('counts today journeys within the span window', () => {
    const journeys = [
      { date: '2026-07-21', tapInTime: '07:50' }, // inside window
      { date: '2026-07-21', tapInTime: '08:30' }, // inside window
    ];
    expect(countJourneyOverlaps(SPAN_CENTRAL, journeys, NOW)).toBe(2);
  });

  it('excludes journeys before the span start', () => {
    const journeys = [{ date: '2026-07-21', tapInTime: '07:00' }]; // before 07:42
    expect(countJourneyOverlaps(SPAN_CENTRAL, journeys, NOW)).toBe(0);
  });

  it('excludes journeys from other dates', () => {
    const journeys = [{ date: '2026-07-20', tapInTime: '08:00' }];
    expect(countJourneyOverlaps(SPAN_CENTRAL, journeys, NOW)).toBe(0);
  });

  it('excludes journeys with null tapInTime', () => {
    const journeys = [{ date: '2026-07-21', tapInTime: null }];
    expect(countJourneyOverlaps(SPAN_CENTRAL, journeys, NOW)).toBe(0);
  });
});

// --- formatElapsedShort / formatSinceLabel ---

describe('formatElapsedShort', () => {
  it('strips "ago" suffix', () => {
    // 32 min
    expect(formatElapsedShort(0, 32 * 60_000)).toBe('32 min');
  });

  it('handles hours', () => {
    expect(formatElapsedShort(0, (60 + 19) * 60_000)).toBe('1 h 19 min');
  });
});

describe('formatSinceLabel', () => {
  const startMs = new Date('2026-07-21T06:42:00.000Z').getTime(); // 07:42 BST

  it('returns HH:MM for spans under 24 h', () => {
    expect(formatSinceLabel(startMs, NOW.getTime())).toBe('07:42');
  });

  it('returns "ddd HH:MM" (no "since" prefix) for spans over 24 h', () => {
    const twoDaysLater = new Date('2026-07-23T07:14:00.000Z').getTime();
    expect(formatSinceLabel(startMs, twoDaysLater)).toMatch(/^\w{3} 07:42$/);
    expect(formatSinceLabel(startMs, twoDaysLater)).not.toMatch(/^since/);
  });
});

// --- buildStatusBoard ---

describe('buildStatusBoard', () => {
  it('marks central as disrupted with active span', () => {
    const board = buildStatusBoard(SNAPSHOT, CATALOG, ['central'], [], NOW);
    const central = board.yourLines[0];
    expect(central.lineId).toBe('central');
    expect(central.severity).toBe(6);
    expect(central.activeSpan).not.toBeNull();
  });

  it('marks jubilee as good service when coverage exists', () => {
    const board = buildStatusBoard(SNAPSHOT, CATALOG, [], [], NOW);
    const jubilee = board.otherLines.find(r => r.lineId === 'jubilee')!;
    expect(jubilee.description).toBe('Good service');
    expect(jubilee.activeSpan).toBeNull();
  });

  it('marks jubilee as no live data when coverage absent', () => {
    const noData: LedgerSnapshot = { ...SNAPSHOT, coverage: [] };
    const board = buildStatusBoard(noData, CATALOG, [], [], NOW);
    const jubilee = board.otherLines.find(r => r.lineId === 'jubilee')!;
    expect(jubilee.description).toBe('No live data');
  });

  it('puts your lines in yourLines section', () => {
    const board = buildStatusBoard(SNAPSHOT, CATALOG, ['central'], [], NOW);
    expect(board.yourLines.map(r => r.lineId)).toContain('central');
    expect(board.otherLines.map(r => r.lineId)).not.toContain('central');
  });

  it('sorts disrupted rows before good service within a section', () => {
    const jubileeSevere: DisruptionSpan = {
      ...SPAN_CENTRAL,
      line: 'jubilee',
      lineName: 'Jubilee',
      severity: 9,
    };
    const snapshot2: LedgerSnapshot = {
      ...SNAPSHOT,
      spans: [SPAN_CENTRAL, jubileeSevere],
    };
    const board = buildStatusBoard(snapshot2, CATALOG, [], [], NOW);
    // Both are in otherLines; Central (6) should come before Jubilee (9)
    expect(board.otherLines[0].lineId).toBe('central');
    expect(board.otherLines[1].lineId).toBe('jubilee');
  });

  it('includes generatedAt from snapshot', () => {
    const board = buildStatusBoard(SNAPSHOT, CATALOG, [], [], NOW);
    expect(board.generatedAt).toBe(SNAPSHOT.generatedAt);
  });

  it('builds a 12-segment timeline', () => {
    const board = buildStatusBoard(SNAPSHOT, CATALOG, ['central'], [], NOW);
    expect(board.yourLines[0].todayTimeline).toHaveLength(12);
  });
});
