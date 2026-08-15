/**
 * Make an isolated `LIBI_HOME` carry the media binaries a real one carries.
 *
 * ## The problem this solves
 *
 * Tests never run against the developer's real `~/.libi` — the vitest global
 * setup repoints `LIBI_HOME` at a temp dir, and `createTempStorageDir()`
 * repoints it again per test. Both produce a home with an EMPTY `bin/`.
 *
 * That is safe but unfaithful. In production Category A always provisions
 * `<LIBI_HOME>/bin/ffmpeg`, so `resolveBin` (lib/ffmpeg/exec.ts) finds it
 * there and never reaches its PATH fallback. Under an empty temp home every
 * ffmpeg test instead ran against whatever `ffmpeg` PATH happened to hold —
 * a binary libi does not ship and has no control over.
 *
 * On this maintainer's machine that was Homebrew's build, which omits
 * libfreetype and therefore has no `drawtext` filter. Two caption burn-in
 * tests skipped themselves as "ffmpeg can't do drawtext" while the binary
 * libi actually ships does it fine — a real feature going untested because
 * the harness pointed somewhere else. The same substitution silently applied
 * to every other ffmpeg test; drawtext is just where the builds differed
 * loudly enough to notice.
 *
 * Linking the provisioned binaries into each isolated home restores the
 * production shape. When the real home has not been provisioned (a clean
 * clone, CI) nothing is linked and the PATH fallback still applies — which
 * is why the CI workflow installs ffmpeg.
 */
import fs from "node:fs";
import path from "node:path";
import { realLibiHome } from "./tracking-env";

/** Binaries Category A provisions that tests legitimately execute. */
const PROVISIONED = ["ffmpeg", "ffprobe"] as const;

function exeName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Symlink the Category-A-provisioned media binaries from the real libi home
 * into `home/bin`, creating the directory if needed. Read-only executables,
 * so a link carries no risk of a test writing back to the real home.
 *
 * Silent and idempotent: a missing source, an existing link, or a platform
 * that refuses symlinks all leave the caller on the PATH fallback, which is
 * exactly what a machine without a provisioned home gets.
 */
export function linkProvisionedBinaries(home: string): void {
  const realBin = path.join(realLibiHome(), "bin");
  if (path.resolve(realBin) === path.resolve(home, "bin")) return;

  let binDir: string;
  try {
    binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
  } catch {
    return;
  }

  for (const name of PROVISIONED) {
    const source = path.join(realBin, exeName(name));
    const target = path.join(binDir, exeName(name));
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.symlinkSync(source, target);
    } catch {
      /* fall back to PATH resolution, same as a clean clone */
    }
  }
}
