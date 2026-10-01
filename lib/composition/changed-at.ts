import fs from "node:fs";
import path from "node:path";
import { getStorage } from "@/lib/storage";
import { OVERLAYS_DIR } from "@/lib/overlays/paths";

/** The draft composition's file (`MANIFEST_FILE` in lib/composition/persistence.ts). */
const COMPOSITION_FILE = "composition.json";

/**
 * When this piece's draft last changed on disk, as epoch ms: the newest mtime
 * of `composition.json` and every file under `overlays/` — a code overlay's
 * body lives in its own file, which the agent edits directly
 * (`codeFilePath`), so the manifest's own mtime alone would miss that edit.
 * `null` when the piece never saved a composition.
 *
 * fs-only (no db), so the MCP child can ask it: `libi.post_piece` reuses an
 * export only when it began after this.
 */
export async function compositionChangedAtMs(pieceId: string): Promise<number | null> {
  const storage = await getStorage();
  let newest: number;
  try {
    newest = fs.statSync(storage.localPath(pieceId, COMPOSITION_FILE)).mtimeMs;
  } catch {
    return null;
  }
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {
          // Removed between the listing and the stat: nothing newer to count.
        }
      }
    }
  };
  walk(storage.localPath(pieceId, OVERLAYS_DIR));
  return newest;
}
