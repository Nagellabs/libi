// electron/self-update-probe.ts
//
// "Can this installation replace its own bundle?" — asked BEFORE a download
// starts, not discovered after one finishes.
//
// ## The bug this exists for
//
// During the 0.1.2 QA run the shell updater found 0.1.2, downloaded all
// 481 MB, and only then said:
//
//     shell-updater: ERROR Cannot update while running on a read-only volume.
//
// The app was running from `/private/var/folders/…/AppTranslocation/…/Libi.app`.
// macOS App Translocation runs a still-quarantined app from a randomised
// READ-ONLY path, and Squirrel cannot swap a bundle it cannot write.
// `/Applications/Libi.app` was still quarantined because it had been installed
// with `cp` (which preserves the quarantine xattr) rather than dragged in
// Finder (which clears it).
//
// The failure was a log line and nothing else. The UI offered "Try again",
// which re-downloaded 481 MB and failed identically, forever — a user pinned
// to their version with no way to find out why.
//
// ## Why a write probe and not `app.isInApplicationsFolder()`
//
// `isInApplicationsFolder()` is the tempting gate and the wrong one. Somebody
// legitimately running from `~/Applications`, or any other writable place,
// would be told they cannot update when they perfectly well can — and a false
// block is worse than the bug, because it has no workaround at all.
//
// The precondition Squirrel actually needs is write access to the directory
// CONTAINING the bundle, so that is what gets probed. `isInApplicationsFolder()`
// earns its keep phrasing the advice afterwards; it never decides the block.
//
// ## Platform scope, stated honestly
//
// The write probe is cross-platform, which is the reason for choosing it, but
// only the macOS behaviour has been observed on a real machine. Windows'
// analogue (a protected install directory needing elevation) and Linux's (a
// read-only AppImage location) are reasoned-about, not verified — that waits
// on the QA lab. Linux packages installed by apt/dnf are deliberately NEVER
// blocked: electron-updater does not self-update those at all, so a block
// there would be pure false positive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Why the bundle cannot be replaced in place. Chooses the ADVICE, not the
 * verdict — the write probe already decided that.
 */
export type SelfUpdateBlockReason =
  /** macOS is running a quarantined copy from a randomised read-only path. */
  | "translocated"
  /** Running straight off a mounted disk image. */
  | "running-from-dmg"
  /** Somewhere writable-looking but not Applications, and still unwritable. */
  | "not-in-applications"
  /** Everything else: a genuinely read-only or administered location. */
  | "read-only-location";

export interface SelfUpdateProbeResult {
  ok: boolean;
  reason?: SelfUpdateBlockReason;
  /**
   * The bundle path. Shown to the user VERBATIM when blocked — it is the one
   * thing that turns an abstract message into something they can act on, and
   * it is what let this be diagnosed in the first place.
   */
  path: string;
  /** The directory that must be writable — where the probe actually ran. */
  targetDir: string;
}

export interface SelfUpdateProbeOptions {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `app.getPath("exe")`. */
  execPath: string;
  /** `process.env.APPIMAGE` when set — the file electron-updater replaces. */
  appImagePath?: string | null;
  /**
   * `app.isInApplicationsFolder()`. Used ONLY to phrase the advice on macOS.
   * Never consulted to decide whether to block.
   */
  isInApplicationsFolder?: boolean;
  /** Injected by tests. Defaults to a real write-then-unlink. */
  canWrite?: (dir: string) => boolean;
}

/**
 * The bundle electron-updater would replace.
 *
 * macOS swaps the whole `.app`, so walk up from the executable to it. Linux
 * AppImage replaces the AppImage FILE, whose path only `process.env.APPIMAGE`
 * knows — the executable itself lives inside the read-only mount and probing
 * next to it would block every AppImage user. Windows replaces the contents of
 * the install directory the executable sits in.
 */
export function updateBundlePath(
  platform: NodeJS.Platform,
  execPath: string,
  appImagePath?: string | null,
): string {
  if (platform === "darwin") {
    // Keep walking past the first hit: helper bundles nest inside the app
    // (`Libi.app/Contents/Frameworks/…Helper.app`), and Squirrel replaces the
    // OUTERMOST one.
    let dir = path.dirname(execPath);
    let outermost: string | null = null;
    while (dir !== path.dirname(dir)) {
      if (dir.endsWith(".app")) outermost = dir;
      dir = path.dirname(dir);
    }
    return outermost ?? path.dirname(execPath);
  }
  if (platform === "linux" && appImagePath) return appImagePath;
  return execPath;
}

/** Write a file into `dir` and remove it again. The gate, and nothing else. */
function probeWrite(dir: string): boolean {
  const probe = path.join(dir, `.libi-update-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this installation update itself in place?
 *
 * `ok: true` means the containing directory took a write. Everything else is
 * classification for the message.
 */
export function probeSelfUpdate(opts: SelfUpdateProbeOptions): SelfUpdateProbeResult {
  const bundlePath = updateBundlePath(opts.platform, opts.execPath, opts.appImagePath);
  const targetDir = path.dirname(bundlePath);

  // apt/dnf/pacman installs are updated by the package manager, not by us.
  // electron-updater never tries, so there is nothing here to block.
  if (opts.platform === "linux" && !opts.appImagePath) {
    return { ok: true, path: bundlePath, targetDir };
  }

  const canWrite = opts.canWrite ?? probeWrite;
  if (canWrite(targetDir)) return { ok: true, path: bundlePath, targetDir };

  return {
    ok: false,
    reason: classify(opts, bundlePath),
    path: bundlePath,
    targetDir,
  };
}

function classify(
  opts: SelfUpdateProbeOptions,
  bundlePath: string,
): SelfUpdateBlockReason {
  if (bundlePath.includes("/AppTranslocation/")) return "translocated";
  if (bundlePath.startsWith("/Volumes/")) return "running-from-dmg";
  // Only meaningful on macOS — elsewhere there is no Applications folder to
  // not be in, and answering "not-in-applications" would be nonsense copy.
  if (opts.platform === "darwin" && opts.isInApplicationsFolder === false) {
    return "not-in-applications";
  }
  return "read-only-location";
}

/**
 * Delete a `pending/` download left behind by a build that downloaded before
 * it checked. Nothing will ever install it, and on this machine it was 481 MB.
 *
 * Mirrors electron-updater's own cache-path derivation (`AppAdapter.getAppCacheDir`
 * + `updaterCacheDirName` out of `app-update.yml`) rather than guessing, and
 * does nothing at all if either half cannot be resolved — a failure to tidy up
 * must never be louder than the thing it is tidying.
 */
export function clearPendingShellDownload(resourcesPath: string): string | null {
  const dirName = readUpdaterCacheDirName(resourcesPath);
  if (!dirName) return null;
  const pending = path.join(appCacheDir(), dirName, "pending");
  try {
    if (!fs.existsSync(pending)) return null;
    fs.rmSync(pending, { recursive: true, force: true });
    return pending;
  } catch {
    return null;
  }
}

function readUpdaterCacheDirName(resourcesPath: string): string | null {
  // `process.resourcesPath` is undefined outside a packaged Electron app.
  if (typeof resourcesPath !== "string" || !resourcesPath) return null;
  try {
    const yml = fs.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8");
    const m = /^updaterCacheDirName:\s*(.+)$/m.exec(yml);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

function appCacheDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Caches");
  return process.env.XDG_CACHE_HOME || path.join(home, ".cache");
}
