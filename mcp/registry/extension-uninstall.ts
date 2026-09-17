// mcp/registry/extension-uninstall.ts
//
// Give back the disk an extension took.
//
// libi's extensions download between 121 MB (Kokoro) and ~8 GB (ACE-Step) onto
// the user's machine, on demand, and until now there was no way to undo that
// from inside libi: Settings rendered install progress, dependency chips and an
// approval switch, and no Remove of any kind. Removing one of the user's OWN
// providers is a command they submit on the Agents page, and never touches
// libi's extensions at all.
//
// ## What may be deleted, and what may NOT
//
// An extension's dependency list is not the same as the set of things it owns.
// Three of the declared deps are SHARED, and deleting them here would break a
// different extension the user did not ask to remove:
//
//   * `uv` — declared by youtube-download, whisper, local-tts and local-music,
//     and it is one binary in `<LIBI_HOME>/bin`.
//   * the uv cache / python installs under `<LIBI_HOME>/uv/` — shared by every
//     `uv run --with` env; the TTS, Whisper and music "envs" are only a token
//     plus entries in that cache.
//   * `chromium` — the export driver's browser, which the tracking engine also
//     launches (`lib/tracking/mediapipe-runner.ts`).
//
// So removal is scoped to what an extension EXCLUSIVELY owns, which is also
// where essentially all of the bytes are: its model directory, and — for
// tracking, the only one with a real venv — its own uv environment. An
// extension with nothing exclusive is not removable, and the UI does not offer
// a Remove for it rather than offering one that frees nothing.
//
// Deleting the model directory takes its `.install-token` with it (the token
// lives inside the directory for every files[]-shaped dep), which is what makes
// the extension read as `pending` again afterwards: `settleInstallStatus`
// re-derives the row from disk, so nothing here writes a status by hand.

import fs from "node:fs";
import path from "node:path";

import { getLibiHome, getLibiModelsDir } from "@/lib/libi-home";
import { ttsModelsDir } from "@/lib/tts/voices";
import { whisperModelsDir } from "@/lib/whisper/models";
import { aceStepModelsDir } from "@/lib/music/models";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";
import { trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { serverLogger as logger } from "@/lib/logger";
import {
  REMOVABLE_EXTENSION_IDS,
  isRemovableExtension,
  type RemovableExtensionId,
} from "@/lib/settings/removable-extensions";

/** What one extension exclusively owns on disk. */
export interface RemovableExtension {
  /** Directories deleted whole. */
  dirs: () => string[];
  /** Loose token files under LIBI_HOME, deleted if present. */
  tokens: string[];
}

/**
 * Extensions with reclaimable disk of their own.
 *
 * `libi-export` (chromium — shared with tracking) and `youtube-download`
 * (`uv` + a uv-installed yt-dlp, both shared state) are deliberately absent.
 */
const REMOVABLE: Record<RemovableExtensionId, RemovableExtension> = {
  "local-tts": {
    dirs: () => [ttsModelsDir()],
    tokens: [".libi-tts-env.install-token"],
  },
  whisper: {
    dirs: () => [whisperModelsDir()],
    tokens: [".libi-whisper-env.install-token"],
  },
  "local-music": {
    dirs: () => [aceStepModelsDir()],
    tokens: [".libi-ace-step-env.install-token", ".libi-music-analysis.install-token"],
  },
  "libi-tracking": {
    dirs: () => [
      trackingModelsDir(),
      trackingVenvDir(),
      // The 33 MB mediapipe wasm + task assets: a files[] dep with
      // `destination: "models"`, so `<models>/<binary>/`.
      path.join(getLibiModelsDir(), "mediapipe-vision"),
    ],
    tokens: [],
  },
};

// The id list itself lives in `lib/settings/removable-extensions.ts` so the
// client can read it; re-exported here because this is where a reader looks.
export { REMOVABLE_EXTENSION_IDS, isRemovableExtension };

export interface RemoveResult {
  removed: string[];
  freedBytes: number;
}

function dirSize(target: string): number {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += fs.statSync(full).size;
      } catch {
        /* raced with the delete, or a broken symlink */
      }
    }
  }
  return total;
}

/**
 * Delete an extension's exclusively-owned files.
 *
 * Does NOT touch the database — the caller re-settles the row so the status is
 * re-derived from disk rather than asserted. Throws only for an id that is not
 * removable; a file that will not delete is logged and skipped, because a
 * half-freed extension still re-derives correctly (whatever survived keeps the
 * row `pending` or `installed` truthfully).
 */
export function removeExtensionFiles(id: string): RemoveResult {
  const spec = isRemovableExtension(id) ? REMOVABLE[id] : undefined;
  if (!spec) throw new Error(`${id} has no files of its own to remove`);

  const removed: string[] = [];
  let freedBytes = 0;

  for (const dir of spec.dirs()) {
    if (!fs.existsSync(dir)) continue;
    const size = dirSize(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
      freedBytes += size;
    } catch (err) {
      logger.warn(
        { tag: "mcp-config", op: "extension_remove_failed", mcpId: id, path: dir, err: (err as Error).message },
        "could not delete an extension directory",
      );
    }
  }

  for (const token of spec.tokens) {
    const full = path.join(getLibiHome(), token);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch {
      /* best-effort: a stale env token only costs a re-validation */
    }
  }

  logger.info(
    { tag: "mcp-config", op: "extension_removed", mcpId: id, count: removed.length, freedBytes },
    "removed an extension's installed files",
  );
  return { removed, freedBytes };
}
