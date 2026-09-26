import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getLibiHome } from "@/lib/libi-home";
import { isTestMode } from "@/lib/test-mode";

/** Default root for exported videos.
 *
 *  In test mode (`LIBI_TEST_MODE=1`, which is what skill-eval boots) it is
 *  `<LIBI_HOME>/exports`, so a hermetic run under a scratch home never writes
 *  into the user's real Movies/Videos folder — eval runs did, before this.
 *  (`LIBI_TEST_MODE=1 npx @nagellabs/libi` on the real home exports into
 *  `~/.libi/exports` too.)
 *
 *  Otherwise it is the per-OS video folder, picked to match user expectations:
 *  macOS ships a Movies folder; Windows + Linux ship Videos. That includes a
 *  worktree dev boot, which is NOT test mode: deliberately so, because a
 *  developer's worktree exports are real files they want to find where they
 *  always look. */
export function defaultExportFolder(): string {
  if (isTestMode()) return path.join(getLibiHome(), "exports");
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Movies", "libi");
    case "win32":
      return path.join(home, "Videos", "libi");
    default:
      return path.join(home, "Videos", "libi");
  }
}

/** Ensure a folder exists. Throws on permission errors so the export
 *  surfaces a clear error to the user rather than silently writing nowhere. */
export function ensureFolderExists(absPath: string): void {
  fs.mkdirSync(absPath, { recursive: true });
}

/** Returns true iff the folder exists and is writable by the current user.
 *  Used by the export modal to pre-flight before submitting. */
export function isFolderWritable(absPath: string): boolean {
  try {
    fs.accessSync(absPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
