import fs from "node:fs";
import path from "node:path";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getAnalysisDir } from "@/lib/analysis/storage";
import { recordEvictedProxy } from "@/lib/proxy/evicted";
import { proxyLogger as logger } from "@/lib/logger";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * What a file's bytes drag along when it changes scope (`assignFile`: the
 * library → a piece, or piece → piece). Everything here lives in the file's
 * SCOPE folder, `<storage>/<pieceId | _global>/`, and every reader finds it
 * through the row's CURRENT `pieceId`:
 *
 * - the preview proxy, `<base>-proxy.mp4` (`/api/files/by-id/:id/proxy`);
 * - the timeline filmstrip, `<base>-filmstrip.jpg`;
 * - the analysis folder, `_analysis/<fileId>/` (frames, audio, chunks).
 *
 * `assignFile` used to move only the original, so a video an agent downloaded
 * to the library and then assigned to a piece kept a row saying "proxy ready"
 * whose proxy sat in `_global/`: the proxy route answered 404 and the asset
 * view showed a black player at 0:00 until "View original" was pressed.
 *
 * Call BEFORE the row's `pieceId` changes, and fold the returned patch into
 * the same update. Never throws: an artifact that can't follow is dropped (the
 * proxy is recorded as evicted, so the piece's next open re-makes it), never
 * left pointing at a folder the row no longer names.
 */
export type DerivedPatch = Partial<
  Pick<
    FileRecord,
    | "proxyFilename"
    | "proxyStatus"
    | "proxyGeneratedAt"
    | "filmstripFilename"
    | "filmstripStatus"
    | "filmstripGeneratedAt"
    | "filmstripFrames"
    | "filmstripHeight"
  >
>;

function scopeDir(pieceId: string | null): string {
  return path.join(getLibiStorageDir(), pieceId ?? "_global");
}

/** The proxy name `proxy_gen` gives a file of this name (lib/jobs/runners/proxy-gen.ts). */
export function proxyNameFor(filename: string, ext: string): string {
  return `${path.basename(filename, path.extname(filename))}-proxy.${ext}`;
}

function warn(op: string, fileId: string, err: unknown): void {
  logger.warn(
    { tag: "proxy", op, fileId, err: err instanceof Error ? err.message : String(err) },
    `move_derived.${op}`,
  );
}

export function moveDerivedArtifacts(
  file: Pick<
    FileRecord,
    "id" | "pieceId" | "proxyFilename" | "proxyStatus" | "filmstripFilename" | "filmstripStatus"
  >,
  toPieceId: string | null,
  newFilename: string,
): DerivedPatch {
  const patch: DerivedPatch = {};
  const fromDir = scopeDir(file.pieceId);
  const toDir = scopeDir(toPieceId);

  if (file.proxyFilename) {
    const src = path.join(fromDir, file.proxyFilename);
    const ext = path.extname(file.proxyFilename).slice(1) || "mp4";
    const destName = proxyNameFor(newFilename, ext);
    const dest = path.join(toDir, destName);
    let moved = false;
    // Never over another file's bytes: a destination name already taken means
    // the proxy is re-made rather than moved.
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.mkdirSync(toDir, { recursive: true });
        fs.renameSync(src, dest);
        moved = true;
      } catch (err) {
        warn("move_proxy_failed", file.id, err);
      }
    }
    if (moved) {
      patch.proxyFilename = destName;
    } else {
      try {
        fs.rmSync(src, { force: true });
      } catch (err) {
        warn("drop_proxy_failed", file.id, err);
      }
      patch.proxyFilename = null;
      patch.proxyStatus = "idle";
      patch.proxyGeneratedAt = null;
      if (file.proxyStatus === "ready") {
        try {
          recordEvictedProxy(file.id, 0);
        } catch (err) {
          warn("record_evicted_failed", file.id, err);
        }
      }
    }
    logger.info(
      { tag: "proxy", op: moved ? "proxy_moved_with_file" : "proxy_dropped_on_move", fileId: file.id, toPieceId },
      "move_derived.proxy",
    );
  }

  // The filmstrip is cheap and the timeline re-ensures it when it next shows
  // the clip: dropped, not moved.
  if (file.filmstripFilename || file.filmstripStatus !== "idle") {
    if (file.filmstripFilename) {
      try {
        fs.rmSync(path.join(fromDir, file.filmstripFilename), { force: true });
      } catch (err) {
        warn("drop_filmstrip_failed", file.id, err);
      }
    }
    patch.filmstripFilename = null;
    patch.filmstripStatus = "idle";
    patch.filmstripGeneratedAt = null;
    patch.filmstripFrames = null;
    patch.filmstripHeight = null;
  }

  moveAnalysisDir(file.id, file.pieceId, toPieceId);
  return patch;
}

/**
 * Move `_analysis/<fileId>/` from one scope to another. A destination that
 * already exists is left alone (and the source with it): it is newer.
 * Returns whether it moved.
 */
export function moveAnalysisDir(fileId: string, fromPieceId: string | null, toPieceId: string | null): boolean {
  const src = getAnalysisDir(fromPieceId, fileId);
  const dest = getAnalysisDir(toPieceId, fileId);
  if (src === dest || !fs.existsSync(src) || fs.existsSync(dest)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return true;
  } catch (err) {
    warn("move_analysis_failed", fileId, err);
    return false;
  }
}
