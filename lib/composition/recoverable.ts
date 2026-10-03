/**
 * Hidden recoverable drafts (agent-speed C1).
 *
 * `discard` throws a draft away and `restore` replaces it: both used to be
 * final, which is why each asks the user first. Instead of a second gate, the
 * draft is kept before it is lost — composition AND storyboard, the two things
 * a discard resets — so a wrong call costs one `restore`, not the work.
 *
 * Deliberately NOT the history ring: these never appear in `recentSnapshots`
 * or the version timeline (`snapshots.ts`), so the user's list of saves stays
 * theirs. They live in the piece's storage (`snapshots/recoverable/`), so the
 * piece's delete removes them with everything else, are kept
 * {@link RECOVERABLE_DAYS} days (at most {@link RECOVERABLE_MAX}, oldest out)
 * and are pruned on every write and read. An id starts with `rec-`, which is
 * how `restoreSnapshot` tells one from a history snapshot.
 */
import { getStorage } from "@/lib/storage";
import { loadStoryboard } from "@/lib/storyboard/repo";
import { withStoryboardLock } from "@/lib/storyboard/lock";
import type { Storyboard } from "@/lib/storyboard/types";
import type { CompositionManifest } from "./persistence";

export const RECOVERABLE_DAYS = 7;
export const RECOVERABLE_MAX = 10;
export const RECOVERABLE_ID_PREFIX = "rec-";

const DIR = "snapshots/recoverable";
const INDEX_PATH = `${DIR}/index.json`;

/** What took the draft away. */
export type RecoverableKind = "discarded" | "before-restore" | "before-recover";

export interface RecoverableDraft {
  id: string;
  kind: RecoverableKind;
  /** Unix seconds when it was kept. */
  keptAt: number;
  overlays: number;
  audioClips: number;
}

interface Index {
  entries: RecoverableDraft[]; // newest first
}

interface Stash {
  manifest: CompositionManifest;
  storyboard: Storyboard | null;
}

export function isRecoverableId(id: string): boolean {
  return id.startsWith(RECOVERABLE_ID_PREFIX);
}

async function readIndex(pieceId: string): Promise<Index> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, INDEX_PATH))) return { entries: [] };
  try {
    const parsed = JSON.parse((await storage.read(pieceId, INDEX_PATH)).toString("utf-8")) as Index;
    return Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeIndex(pieceId: string, index: Index): Promise<void> {
  const storage = await getStorage();
  await storage.save(pieceId, INDEX_PATH, Buffer.from(JSON.stringify(index, null, 2), "utf-8"), "application/json");
}

/** Drop what is past its days or over the cap (files too). Returns the kept list, newest first. */
async function prune(pieceId: string, index: Index, nowSec: number): Promise<RecoverableDraft[]> {
  const storage = await getStorage();
  const cutoff = nowSec - RECOVERABLE_DAYS * 86_400;
  const live = index.entries.filter((e) => e.keptAt >= cutoff).slice(0, RECOVERABLE_MAX);
  const gone = index.entries.filter((e) => !live.includes(e));
  for (const e of gone) await storage.remove(pieceId, `${DIR}/${e.id}.json`).catch(() => {});
  if (gone.length > 0) await writeIndex(pieceId, { entries: live });
  return live;
}

/**
 * Keep the piece's current draft (composition + storyboard) as a hidden
 * recoverable draft. The caller decides there IS a draft to keep.
 */
export async function keepDraft(
  pieceId: string,
  kind: RecoverableKind,
  manifest: CompositionManifest,
): Promise<RecoverableDraft> {
  const storage = await getStorage();
  // Read under the storyboard lock like a commit does: never a board another
  // request is halfway through writing. A busy lock fails here, BEFORE anything
  // is changed, so it is a clean refusal.
  const storyboard = await withStoryboardLock(pieceId, () => loadStoryboard(pieceId));
  const nowSec = Math.floor(Date.now() / 1000);
  const id = `${RECOVERABLE_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stash: Stash = { manifest, storyboard };
  await storage.save(pieceId, `${DIR}/${id}.json`, Buffer.from(JSON.stringify(stash), "utf-8"), "application/json");
  const entry: RecoverableDraft = {
    id,
    kind,
    keptAt: nowSec,
    overlays: manifest.overlays?.length ?? 0,
    audioClips: manifest.audioClips?.length ?? 0,
  };
  const index = await readIndex(pieceId);
  index.entries.unshift(entry);
  await writeIndex(pieceId, index);
  await prune(pieceId, await readIndex(pieceId), nowSec);
  return entry;
}

/** The piece's hidden recoverable drafts, newest first, with the expired ones gone. */
export async function listRecoverableDrafts(pieceId: string): Promise<RecoverableDraft[]> {
  const index = await readIndex(pieceId);
  if (index.entries.length === 0) return [];
  return prune(pieceId, index, Math.floor(Date.now() / 1000));
}

/** One kept draft's content; null when it is unknown or has expired. */
export async function loadRecoverableDraft(pieceId: string, id: string): Promise<Stash | null> {
  if (!isRecoverableId(id) || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const live = await listRecoverableDrafts(pieceId);
  if (!live.some((e) => e.id === id)) return null;
  const storage = await getStorage();
  const path = `${DIR}/${id}.json`;
  if (!(await storage.exists(pieceId, path))) return null;
  return JSON.parse((await storage.read(pieceId, path)).toString("utf-8")) as Stash;
}

/** Forget one kept draft (it was recovered). */
export async function dropRecoverableDraft(pieceId: string, id: string): Promise<void> {
  const storage = await getStorage();
  await storage.remove(pieceId, `${DIR}/${id}.json`).catch(() => {});
  const index = await readIndex(pieceId);
  await writeIndex(pieceId, { entries: index.entries.filter((e) => e.id !== id) });
}
