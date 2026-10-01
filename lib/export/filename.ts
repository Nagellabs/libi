import fs from "node:fs";
import path from "node:path";

const RESERVED_WIN = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const FORBIDDEN_CHARS = /[/\\:*?"<>|]/g;
// ASCII control bytes 0x00..0x1F and DEL (0x7F). Unicode-escape form so the
// literal bytes can't be mangled by editors or transport.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** Strip filesystem-unsafe characters from a filename stem (no extension).
 *  Leaves Unicode + spaces + dashes alone — they're part of normal piece
 *  names like "My Beach Day". Trailing dots/spaces are dropped because
 *  Windows silently drops them. Reserved Windows names get a `_` prefix. */
export function sanitizeFilename(stem: string): string {
  let out = stem
    .replace(FORBIDDEN_CHARS, "_")
    .replace(CONTROL_CHARS, "")
    .trim()
    .replace(/[.\s]+$/g, "");
  if (out.length === 0) return "libi-export";
  const base = out.toUpperCase().split(".")[0];
  if (RESERVED_WIN.has(base)) out = `_${out}`;
  return out;
}

/** Given a folder, a base stem, and an extension, find the next available
 *  filename. Returns the absolute path. Does NOT touch the filesystem —
 *  use `claimExportPath` if you need race-safe behaviour. */
export function resolveExportPath(folder: string, baseStem: string, extWithoutDot: string, skip?: ReadonlySet<string>): string {
  const ext = extWithoutDot.replace(/^\./, "");
  // An agent or user who types "clip.mp4" for an mp4 export means the stem
  // "clip", not "clip.mp4.mp4". Only the SAME extension is stripped — a
  // "v1.2" or "cut.mov" stem is kept as written.
  const stem = baseStem.trim().toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    ? baseStem.trim().slice(0, -(ext.length + 1))
    : baseStem;
  const safe = sanitizeFilename(stem);
  const candidate = path.join(folder, `${safe}.${ext}`);
  const taken = (p: string) => skip?.has(p) === true || fs.existsSync(p);
  if (!taken(candidate)) return candidate;
  for (let n = 1; n < 1000; n++) {
    const next = path.join(folder, `${safe}-${n}.${ext}`);
    if (!taken(next)) return next;
  }
  return path.join(folder, `${safe}-${Date.now()}.${ext}`);
}

/** How many permission refusals in a row mean a real denial rather than one delete-pending name. */
const MAX_CONSECUTIVE_DENIALS = 3;

/** Atomically claim a path by creating a zero-byte placeholder, and KEEP it open.
 *  Retries on EEXIST so two concurrent exports of the same piece never collide.
 *  The caller owns `fd` and must close it: while it is open the inode stays
 *  allocated, so no other file can be handed the same device + inode number —
 *  which is what makes that pair a sound identity for "is the path still the
 *  file I created" (the export runner's FileClaim). */
export function claimExportFile(
  folder: string,
  baseStem: string,
  extWithoutDot: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; fd: number } {
  // Names that refused the claim without being visible to `existsSync`.
  const refused = new Set<string>();
  // Consecutive permission refusals: one delete-pending name blocks only that name, so the
  // next suffix normally works. A run of them is a real denial (ACL, Controlled Folder
  // Access, antivirus) and must surface as itself, not as "50 attempts".
  let denials = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = resolveExportPath(folder, baseStem, extWithoutDot, refused);
    try {
      return { path: candidate, fd: fs.openSync(candidate, "wx") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        denials = 0;
        continue;
      }
      // On Windows a name whose file was unlinked while a handle is still open (a cancelled
      // export's runner holds its claim until it has cleaned up) is delete-pending: creating
      // it answers EPERM/EACCES, not EEXIST, and `existsSync` may call it free. It frees
      // itself the moment that handle closes, so this claim simply takes the next suffix.
      if (platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        if (++denials >= MAX_CONSECUTIVE_DENIALS) throw err;
        refused.add(candidate);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not claim an export path under ${folder} after 50 attempts`);
}

/** Atomically claim a path by writing a zero-byte placeholder; the descriptor is closed at once. */
export function claimExportPath(folder: string, baseStem: string, extWithoutDot: string): string {
  const { path: claimed, fd } = claimExportFile(folder, baseStem, extWithoutDot);
  fs.closeSync(fd);
  return claimed;
}
