/**
 * The ambient "draft transaction" a batch of edits runs inside (see ./manifest-transaction.ts).
 *
 * `loadManifest` / `saveManifest` (./persistence.ts) are the ONE seam every composition edit goes
 * through. While a transaction is active FOR A PIECE in the current async context, they read and write
 * that transaction's in-memory manifest instead of the disk, so a batch of ordinary tool handlers runs
 * unchanged against a private copy and the caller decides, at the end, whether it lands. Scoped by
 * AsyncLocalStorage: any other request in the same process, and any other piece, still sees the disk.
 *
 * Leaf module (no imports from persistence) so persistence can read it without a cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CompositionManifest } from "./persistence";

export interface ManifestTxnState {
  readonly pieceId: string;
  /** The manifest as the first read found it (what a rollback leaves in place; the diff's "before"). */
  readonly baseline: CompositionManifest;
  /** The manifest as the edits made so far left it. */
  working: CompositionManifest;
  /** The legacy-scene count the first read reported, handed back by every later read. */
  readonly legacyScenes: number;
  /** A save happened (the working copy may or may not differ from the baseline). */
  dirty: boolean;
}

const als = new AsyncLocalStorage<ManifestTxnState>();

/** The transaction active for `pieceId` in this async context, if any. */
export function activeManifestTxn(pieceId: string): ManifestTxnState | undefined {
  const txn = als.getStore();
  return txn && txn.pieceId === pieceId ? txn : undefined;
}

/** Run `fn` with `txn` as the active transaction for its piece. */
export function runInManifestTxn<T>(txn: ManifestTxnState, fn: () => Promise<T>): Promise<T> {
  return als.run(txn, fn);
}
