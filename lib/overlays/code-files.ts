import fs from "fs/promises";
import { getStorage } from "@/lib/storage";
import { overlayCodeRelPath, overlayDir, OVERLAYS_DIR } from "./paths";
import { overlayCodeFile, getOverlayBody } from "./code-fields";
import type { PersistedOverlay } from "@/lib/composition/persistence";

/** Write an overlay's JS body to its file (no-op for non-code overlays). */
export async function writeOverlayCode(pieceId: string, overlay: PersistedOverlay): Promise<void> {
  const file = overlayCodeFile(overlay);
  const body = getOverlayBody(overlay);
  // DATA-LOSS guard: never clobber an existing code file with an empty/blank
  // body. A meaningful JS draw/scene body is never whitespace-only, so a blank
  // `body` here always means "no body to write" (an un-hydrated or transiently
  // empty manifest), NOT "clear the code". Skipping preserves the last-good
  // file — matching the "broken code retains last-good compiled fn" philosophy.
  // Empty overlay code is an invalid state; there is no legitimate clear-via-save.
  if (!file || body == null || !body.trim()) return;
  const storage = await getStorage();
  await storage.save(pieceId, overlayCodeRelPath(overlay.id, file), Buffer.from(body, "utf-8"), "text/plain");
}

/** Read an overlay's JS body from its file; "" when missing (non-code → ""). */
export async function readOverlayCode(pieceId: string, overlay: PersistedOverlay): Promise<string> {
  const file = overlayCodeFile(overlay);
  if (!file) return "";
  const storage = await getStorage();
  const rel = overlayCodeRelPath(overlay.id, file);
  if (!(await storage.exists(pieceId, rel))) return "";
  return (await storage.read(pieceId, rel)).toString("utf-8");
}

/**
 * List overlay ids that have a dir under overlays/.
 * Uses fs.readdir on the overlays/ subdirectory directly (storage.list() is
 * top-level-only, mirroring how storyboard lists cards/).
 */
export async function listOverlayDirs(pieceId: string): Promise<string[]> {
  const storage = await getStorage();
  const overlaysAbsDir = storage.localPath(pieceId, OVERLAYS_DIR);
  try {
    return await fs.readdir(overlaysAbsDir);
  } catch {
    return [];
  }
}

/** Delete an overlay's whole dir (all its code files). */
export async function deleteOverlayDir(pieceId: string, overlayId: string): Promise<void> {
  // An empty overlayId collapses `overlayDir("")` to the `overlays/` dir
  // itself — a valid, in-bounds path that `fs.rm(..., { recursive: true })`
  // would happily wipe, deleting every overlay's code in the piece. No
  // current route reaches this with an empty id, but fail closed rather
  // than rely on that staying true.
  if (!overlayId) throw new Error("deleteOverlayDir requires an overlayId");
  const storage = await getStorage();
  const dir = overlayDir(overlayId);
  const absDir = storage.localPath(pieceId, dir);
  await fs.rm(absDir, { recursive: true, force: true });
}
