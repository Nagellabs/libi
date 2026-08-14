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
export function resolveExportPath(folder: string, baseStem: string, extWithoutDot: string): string {
  const ext = extWithoutDot.replace(/^\./, "");
  const safe = sanitizeFilename(baseStem);
  const candidate = path.join(folder, `${safe}.${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let n = 1; n < 1000; n++) {
    const next = path.join(folder, `${safe}-${n}.${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(folder, `${safe}-${Date.now()}.${ext}`);
}

/** Atomically claim a path by writing a zero-byte placeholder. Retries on
 *  EEXIST so two concurrent exports of the same piece never collide. */
export function claimExportPath(folder: string, baseStem: string, extWithoutDot: string): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = resolveExportPath(folder, baseStem, extWithoutDot);
    try {
      const fd = fs.openSync(candidate, "wx");
      fs.closeSync(fd);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`Could not claim an export path under ${folder} after 50 attempts`);
}
