// Binds the bundled ledger snapshot to the snapshot lookup. Kept separate from
// ledger-json.ts so that module stays importable under node --experimental-strip-types
// (which can't import JSON modules).
import snapshot from '../data/ledger.json';
import type { LedgerSnapshot } from './ledger-json';
import { makeSnapshotLookup } from './ledger-json';

export const bundledSnapshot = snapshot as LedgerSnapshot;
export const bundledLookup = makeSnapshotLookup(bundledSnapshot);
