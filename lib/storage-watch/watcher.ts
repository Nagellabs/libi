import path from "path";
import { getLibiStorageDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { handleStoryboardChange } from "@/lib/storyboard/watcher";
import { handleOverlayChange } from "@/lib/overlays/watcher";

export type StoragePathKind = { kind: "storyboard" | "overlay"; pieceId: string } | null;

/** Pure dispatch: which subsystem (if any) owns this storage-relative path. */
export function classifyStoragePath(rel: string): StoragePathKind {
  const sb = rel.match(/^([^/]+)\/storyboard\//);
  if (sb) return { kind: "storyboard", pieceId: sb[1] };
  // overlay CODE files only (draw.jsx | scene.jsx | content.jsx)
  const ov = rel.match(/^([^/]+)\/overlays\/[^/]+\/(?:draw|scene|content)\.jsx$/);
  if (ov) return { kind: "overlay", pieceId: ov[1] };
  return null;
}

let started = false;

export async function startStorageWatcher(): Promise<void> {
  if (started) return;
  started = true;
  const { default: chokidar } = await import("chokidar");
  const root = getLibiStorageDir();
  const debounce = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Ignore generated storyboard sketch PNGs (preserve the storyboard rule).
    ignored: (p: string) => /\/storyboard\/cards\/[^/]+\/sketches\/[^/]+\.png$/.test(p),
    depth: 8,
  });

  const onEvent = (filePath: string) => {
    const rel = path.relative(root, filePath);
    const cls = classifyStoragePath(rel);
    if (!cls) return;
    const key = `${cls.kind}:${cls.pieceId}`;
    clearTimeout(debounce.get(key));
    debounce.set(
      key,
      setTimeout(() => {
        if (cls.kind === "storyboard") void handleStoryboardChange(cls.pieceId);
        else void handleOverlayChange(cls.pieceId);
      }, 150),
    );
  };

  watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);
  logger.info({ tag: "storage-watch", op: "watch_start", root }, "storage watcher started");
}
