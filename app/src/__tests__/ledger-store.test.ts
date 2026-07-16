// Tests for TfL-LIVE ledger store: fetch, cache, fallback, and hot-swap.
// Uses jest module mocking to avoid real network calls and AsyncStorage I/O.
import { initLedger, refreshLedger, getLiveSnapshot, getLiveLookup } from '../data/ledger-store';

// --- Mocks ---

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockMultiGet = jest.fn();
const mockMultiSet = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: any[]) => mockGet(...args),
    setItem: (...args: any[]) => mockSet(...args),
    multiGet: (...args: any[]) => mockMultiGet(...args),
    multiSet: (...args: any[]) => mockMultiSet(...args),
  },
}));

const LIVE_SNAPSHOT = {
  generatedAt: '2026-07-16T21:46:32Z',
  sinceISO: '2026-07-09T00:00:00Z',
  coverage: [{ from: '2026-07-09T00:00:00Z', to: '2026-07-16T21:46:32Z', polls: 100 }],
  spans: [
    {
      line: 'northern',
      lineName: 'Northern',
      from: '2026-07-16T08:00:00Z',
      to: '2026-07-16T09:30:00Z',
      severity: 5,
      description: 'Severe delays',
      reason: null,
    },
  ],
};

const LIVE_JSON = JSON.stringify(LIVE_SNAPSHOT);

global.fetch = jest.fn();

function mockFetchSuccess() {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    text: async () => LIVE_JSON,
  });
}

function mockFetchFail() {
  (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMultiGet.mockResolvedValue([
    ['tfl-live-ledger-v1', null],
    ['tfl-live-ledger-fetchedAt-v1', null],
  ]);
  mockMultiSet.mockResolvedValue(undefined);
});

describe('initLedger', () => {
  it('fetches live and returns dataNote=null on success', async () => {
    mockFetchSuccess();
    const result = await initLedger();
    expect(result.fromCache).toBe(false);
    expect(result.generatedAt).toBe('2026-07-16T21:46:32Z');
    expect(result.dataNote).toBeNull();
  });

  it('falls back to bundled snapshot when fetch fails and no cache', async () => {
    mockFetchFail();
    const result = await initLedger();
    expect(result.fromCache).toBe(true);
    expect(result.dataNote).toMatch(/built-in/i);
  });

  it('uses cached snapshot when fetch fails', async () => {
    mockMultiGet.mockResolvedValue([
      ['tfl-live-ledger-v1', LIVE_JSON],
      ['tfl-live-ledger-fetchedAt-v1', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()],
    ]);
    mockFetchFail();
    const result = await initLedger();
    expect(result.fromCache).toBe(true);
    expect(result.dataNote).toMatch(/ago/i);
  });

  it('hot-swaps the lookup after a successful fetch', async () => {
    mockFetchSuccess();
    await initLedger();
    const snapshot = getLiveSnapshot();
    expect(snapshot.generatedAt).toBe('2026-07-16T21:46:32Z');
    const lookup = getLiveLookup();
    expect(typeof lookup).toBe('function');
  });
});

describe('refreshLedger', () => {
  it('no-ops when called within 30 minutes of last fetch', async () => {
    // First do a successful init to set lastFetchAtMs
    mockFetchSuccess();
    await initLedger();
    jest.clearAllMocks();

    // Immediate refresh should be throttled
    await refreshLedger();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
