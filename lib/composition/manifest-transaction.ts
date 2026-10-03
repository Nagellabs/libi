/**
 * A draft transaction for one piece: run any number of ordinary composition edits against an in-memory
 * copy of the manifest, then commit them as ONE disk save, or drop them and leave the draft exactly as
 * it was.
 *
 * Why it exists: `libi.apply_ops` runs a list of the usual tool handlers per piece, and a list that
 * fails on its fifth op must not leave four ops in the draft (no half-applied pieces), nor must a dry
 * run write anything. The handlers all go through `loadManifest` / `saveManifest`, which route to the
 * transaction while one is active in the current async context (./manifest-txn-scope.ts), so the
 * handlers themselves needed no change and there is no second implementation of any edit.
 *
 * Commit refuses, and writes nothing, when `composition.json` changed on disk since the transaction
 * began (the user edited the piece, or another call did): a lost update would silently drop THEIR change.
 * That check and the write run under a per-piece in-process queue, which closes the race between two
 * batches in one process; across processes it narrows it to the gap between the read and the write.
 */
import { loadComposition, manifestFingerprint, saveManifest, type CompositionManifest } from "./persistence";
import { runInManifestTxn, type ManifestTxnState } from "./manifest-txn-scope";

export class ManifestChangedError extends Error {
  constructor(public readonly pieceId: string) {
    super(
      `Piece ${pieceId} was edited while the batch ran, so nothing was written for it. ` +
        "Re-read it and run the batch again.",
    );
    this.name = "ManifestChangedError";
  }
}

export interface ManifestTransaction {
  readonly pieceId: string;
  /** The manifest before any op ran. */
  readonly baseline: CompositionManifest;
  /** The manifest the ops have produced so far. */
  readonly working: CompositionManifest;
  /** Whether the ops changed anything (a save that left the manifest identical is not a change). */
  changed(): boolean;
  /** Run `fn` with this transaction as the piece's manifest. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Write the working copy to disk (the draft). Throws ManifestChangedError when the disk moved on. No-op when nothing changed. */
  commit(): Promise<{ written: boolean }>;
}

/** Per-piece FIFO of commits in this process. */
const commitQueues = new Map<string, Promise<unknown>>();

async function withCommitQueue<T>(pieceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = commitQueues.get(pieceId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => undefined);
  commitQueues.set(pieceId, tail);
  try {
    return await next;
  } finally {
    if (commitQueues.get(pieceId) === tail) commitQueues.delete(pieceId);
  }
}

export async function beginManifestTransaction(pieceId: string): Promise<ManifestTransaction> {
  // A REAL read (no transaction is active yet): it also initializes the piece's snapshot the first time.
  const fingerprint = await manifestFingerprint(pieceId);
  const { manifest, legacyScenes } = await loadComposition(pieceId);
  const state: ManifestTxnState = {
    pieceId,
    baseline: structuredClone(manifest),
    working: structuredClone(manifest),
    legacyScenes,
    dirty: false,
  };
  const baselineJson = JSON.stringify(state.baseline);
  const changed = () => state.dirty && JSON.stringify(state.working) !== baselineJson;
  return {
    pieceId,
    get baseline() {
      return state.baseline;
    },
    get working() {
      return state.working;
    },
    changed,
    run: (fn) => runInManifestTxn(state, fn),
    commit: () =>
      withCommitQueue(pieceId, async () => {
        if (!changed()) return { written: false };
        if ((await manifestFingerprint(pieceId)) !== fingerprint) throw new ManifestChangedError(pieceId);
        // Outside runInManifestTxn: a real save (code bodies to their files, composition.json, hasDraft).
        await saveManifest(pieceId, structuredClone(state.working));
        return { written: true };
      }),
  };
}
