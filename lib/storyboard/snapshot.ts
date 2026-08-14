// lib/storyboard/snapshot.ts
import { getStorage } from "@/lib/storage";
import { clearStoryboard, loadStoryboard, saveStoryboard } from "./repo";
import type { Storyboard } from "./types";

/** Normalize a storyboard for divergence comparison: drop the volatile
 *  `updatedAt`, sort cards by order, and stable-stringify. */
function normalize(sb: Storyboard | null): string {
  if (!sb) return "null";
  const cards = [...sb.cards].sort((a, b) => a.order - b.order);
  return JSON.stringify({
    cardOrder: sb.cardOrder, overview: sb.overview, edges: sb.edges,
    layout: sb.layout, budgetUsd: sb.budgetUsd, cards,
  });
}

/** True when the on-disk storyboard equals its committed snapshot (ignoring
 *  updatedAt). False when they differ OR no snapshot exists. */
export async function storyboardMatchesSnapshot(pieceId: string): Promise<boolean> {
  const snap = await loadStoryboardSnapshot(pieceId);
  if (!snap) return false;
  const current = await loadStoryboard(pieceId);
  return normalize(current) === normalize(snap);
}

const SNAPSHOT_PATH = "snapshots/storyboard-current.json";

/** Serialize the whole composed storyboard (manifest + cards) into one JSON
 *  blob in the snapshot ring. Keeps the snapshot self-contained alongside
 *  composition.json without forcing the per-card file layout into the ring. */
export async function saveStoryboardSnapshot(pieceId: string): Promise<void> {
  const sb = await loadStoryboard(pieceId);
  const storage = await getStorage();
  await storage.save(
    pieceId,
    SNAPSHOT_PATH,
    Buffer.from(JSON.stringify(sb ?? null)),
    "application/json",
  );
}

export async function loadStoryboardSnapshot(pieceId: string): Promise<Storyboard | null> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, SNAPSHOT_PATH))) return null;
  const parsed = JSON.parse((await storage.read(pieceId, SNAPSHOT_PATH)).toString("utf8"));
  return parsed as Storyboard | null;
}

/** Restore the snapshot back onto the live storyboard files (discard draft).
 *  When no snapshot exists (piece was never committed), clears all storyboard
 *  files so discard is symmetric with composition reset-to-empty. */
export async function restoreStoryboardFromSnapshot(pieceId: string): Promise<void> {
  const snap = await loadStoryboardSnapshot(pieceId);
  if (snap) await saveStoryboard(pieceId, snap);
  else await clearStoryboard(pieceId);
}
