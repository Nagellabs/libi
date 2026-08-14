import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Default per-OS root for exported videos. Picked to match user
 *  expectations: macOS ships a Movies folder; Windows + Linux ship Videos. */
export function defaultExportFolder(): string {
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
