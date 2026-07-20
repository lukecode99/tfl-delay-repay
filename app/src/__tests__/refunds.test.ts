// Tests for TfL-RECEIVED-FIX: refund parsing, persistence, and dedup.
import { parseStatement } from '../journeys/parse';
import {
  type DbLike,
  ensureRefundSchema,
  insertRefundsCore,
  totalRefundsCore,
} from '../journeys/store-core';

// Minimal in-memory DbLike for testing refund SQL logic without node:sqlite.
// Implements the exact dedup key the real schema uses:
//   (date, card, raw_action, CAST(ROUND(amount * 100) AS INTEGER))
function makeRefundDb(): DbLike & { rows: () => any[] } {
  const store: { date: string; amount: number; raw_action: string; card: string; period: string; imported_at: string }[] = [];
  const dedupeKey = (date: string, card: string, rawAction: string, amount: number) =>
    `${date}|${card}|${rawAction}|${Math.round(amount * 100)}`;
  const seen = new Set<string>();

  return {
    execSync(_sql: string) { /* schema is a no-op in mock */ },
    runSync(sql: string, ...params: any[]) {
      if (/INSERT OR IGNORE INTO refunds/i.test(sql)) {
        const [date, amount, raw_action, card, period, imported_at] = params;
        const key = dedupeKey(date, card, raw_action, amount as number);
        if (seen.has(key)) return { changes: 0 };
        seen.add(key);
        store.push({ date, amount: amount as number, raw_action, card, period, imported_at });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    getAllSync<T>(_sql: string, ..._params: any[]): T[] { return [] as unknown as T[]; },
    getFirstSync<T>(sql: string, ..._params: any[]): T | null {
      if (/SUM\(amount\)/i.test(sql)) {
        const total = store.reduce((s, r) => s + r.amount, 0);
        return { total } as unknown as T;
      }
      return null;
    },
    withTransactionSync(fn: () => void) { fn(); },
    rows: () => [...store],
  };
}

const NOW = '2026-07-04T12:00:00.000Z';

// ------ parseStatement: refund extraction ------

const OYSTER_HEADER = 'Date,Start Time,End Time,Journey/Action,Charge,Credit,Balance,Note\n';

function oysterCsv(rows: string) { return OYSTER_HEADER + rows; }

describe('parseStatement – refund rows', () => {
  it('extracts a Delay Repay credit row', () => {
    const csv = oysterCsv('31-May-2026,,,Delay Repay,,3.20,10.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(1);
    expect(result.refunds[0]).toEqual({ date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' });
    expect(result.journeys).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('extracts a Service delay refund row', () => {
    const csv = oysterCsv('01-Jun-2026,,,Service delay refund,,1.50,8.50,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(1);
    expect(result.refunds[0].credit).toBe(1.50);
    expect(result.refunds[0].rawAction).toBe('Service delay refund');
  });

  it('handles Delay Repay spelled with a hyphen variant', () => {
    const csv = oysterCsv('01-Jun-2026,,,Delay-Repay,,2.00,6.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(1);
  });

  it('skips Delay Repay rows with no credit amount', () => {
    const csv = oysterCsv('01-Jun-2026,,,Delay Repay,,,6.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('skips Delay Repay rows with no parseable date', () => {
    const csv = oysterCsv(',,,Delay Repay,,2.00,6.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('extracts multiple refunds from a mixed statement', () => {
    const csv = oysterCsv([
      '31-May-2026,08:55,09:22,Brixton to Kings Cross,3.40,,10.00,',
      '31-May-2026,,,Delay Repay,,3.40,13.40,',
      '01-Jun-2026,17:10,17:45,Kings Cross to Brixton,3.40,,10.00,',
      '01-Jun-2026,,,Delay Repay,,3.40,13.40,',
    ].join('\n') + '\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.refunds).toHaveLength(2);
    expect(result.journeys).toHaveLength(2);
  });
});

// ------ parseStatement: diagnostic skips ------

describe('parseStatement – diagnosticSkips', () => {
  it('captures skipped rows that carry a credit amount', () => {
    const csv = oysterCsv('01-Jun-2026,,,Auto top-up,,5.00,20.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.diagnosticSkips).toHaveLength(1);
    expect(result.diagnosticSkips[0]).toMatchObject({
      date: '2026-06-01',
      credit: 5.00,
      rawAction: 'Auto top-up',
    });
  });

  it('does not capture bus journeys in diagnosticSkips', () => {
    const csv = oysterCsv('01-Jun-2026,,,Bus journey, route 73,,1.65,8.35,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.diagnosticSkips).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('does not capture skipped rows with zero or missing credit', () => {
    const csv = oysterCsv('01-Jun-2026,,,Season ticket renewal,,,15.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.diagnosticSkips).toHaveLength(0);
  });

  it('does not capture Delay Repay rows in diagnosticSkips', () => {
    const csv = oysterCsv('31-May-2026,,,Delay Repay,,3.20,10.00,\n');
    const result = parseStatement(csv, 'card-1');
    expect(result.diagnosticSkips).toHaveLength(0);
  });
});

// ------ insertRefundsCore / totalRefundsCore ------

describe('insertRefundsCore', () => {
  it('inserts new refunds and returns correct summary', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const refunds = [
      { date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' },
      { date: '2026-06-01', credit: 1.50, rawAction: 'Delay Repay' },
    ];
    const summary = insertRefundsCore(d, refunds, 'card-1', '5|2026', NOW);
    expect(summary.inserted).toBe(2);
    expect(summary.duplicates).toBe(0);
    expect(d.rows()).toHaveLength(2);
  });

  it('counts duplicates on re-import of same refunds', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const refunds = [{ date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' }];
    insertRefundsCore(d, refunds, 'card-1', '5|2026', NOW);
    const second = insertRefundsCore(d, refunds, 'card-1', '5|2026', NOW);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(d.rows()).toHaveLength(1);
  });

  it('dedupes across 12-month deep-pull re-import', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const refunds = [
      { date: '2026-01-10', credit: 2.80, rawAction: 'Delay Repay' },
      { date: '2026-03-15', credit: 3.40, rawAction: 'Service delay refund' },
    ];
    insertRefundsCore(d, refunds, 'card-1', '1|2026', NOW);
    insertRefundsCore(d, refunds, 'card-1', '3|2026', NOW); // second pull, same refunds
    expect(d.rows()).toHaveLength(2);
  });

  it('treats same date + same amount but different rawAction as distinct refunds', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const r1 = { date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' };
    const r2 = { date: '2026-05-31', credit: 3.20, rawAction: 'Service delay refund' };
    const summary = insertRefundsCore(d, [r1, r2], 'card-1', '5|2026', NOW);
    expect(summary.inserted).toBe(2);
    expect(d.rows()).toHaveLength(2);
  });

  it('treats same date + same action but different amounts as distinct refunds', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const r1 = { date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' };
    const r2 = { date: '2026-05-31', credit: 1.50, rawAction: 'Delay Repay' };
    const summary = insertRefundsCore(d, [r1, r2], 'card-1', '5|2026', NOW);
    expect(summary.inserted).toBe(2);
    expect(d.rows()).toHaveLength(2);
  });

  it('returns empty summary with no refunds', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const summary = insertRefundsCore(d, [], 'card-1', '5|2026', NOW);
    expect(summary).toEqual({ inserted: 0, duplicates: 0 });
  });
});

describe('totalRefundsCore', () => {
  it('returns 0 when no refunds stored', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    expect(totalRefundsCore(d)).toBe(0);
  });

  it('sums all inserted refund amounts', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    insertRefundsCore(d, [
      { date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' },
      { date: '2026-06-01', credit: 1.50, rawAction: 'Delay Repay' },
      { date: '2026-06-15', credit: 2.80, rawAction: 'Service delay refund' },
    ], 'card-1', '5|2026', NOW);
    expect(totalRefundsCore(d)).toBeCloseTo(7.50);
  });

  it('does not double-count duplicate refunds', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    const refunds = [{ date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' }];
    insertRefundsCore(d, refunds, 'card-1', '5|2026', NOW);
    insertRefundsCore(d, refunds, 'card-1', '5|2026', NOW); // re-import
    expect(totalRefundsCore(d)).toBeCloseTo(3.20);
  });

  it('sums refunds across multiple cards', () => {
    const d = makeRefundDb();
    ensureRefundSchema(d);
    insertRefundsCore(d, [{ date: '2026-05-31', credit: 3.20, rawAction: 'Delay Repay' }], 'card-1', '5|2026', NOW);
    insertRefundsCore(d, [{ date: '2026-06-01', credit: 2.00, rawAction: 'Delay Repay' }], 'card-2', '6|2026', NOW);
    expect(totalRefundsCore(d)).toBeCloseTo(5.20);
  });
});
