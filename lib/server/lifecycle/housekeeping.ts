// lib/server/lifecycle/housekeeping.ts
//
// Disk libi allocated and no longer needs. Runs in Category B, fire-and-forget,
// after the app is already usable — housekeeping must never block or fail boot.
//
// Two reclaims, both measured on this machine (2026-09-08):
//
//   1. **Stale Playwright browser revisions — 1.6 GB across three.** Playwright
//      installs into `~/Library/Caches/ms-playwright/<browser>-<revision>/` and
//      never removes an old one. Every `playwright-core` bump strands the
//      previous revision there forever, and nothing in libi or Playwright
//      sweeps it (`PLAYWRIGHT_SKIP_BROWSER_GC` gates Playwright's own GC, which
//      only runs during an install and only for browsers it knows about).
//
//      **The cache is shared, so libi prunes only what libi installed.** Every
//      Playwright user on the machine — the Playwright MCP that drives libi's
//      own Electron tests, an `npx playwright` from another checkout, any other
//      tool — installs into that same directory, each pinning its own revision,
//      so "every revision except ours" would delete browsers that other tools
//      are still launching. A revision is libi's iff its directory carries a
//      `LIBI_INSTALLED_MARKER` file, which the Chromium installer writes via
//      `markLibiInstalled()` after a successful `playwright install`; the
//      pinned revision is kept regardless, and an unmarked one is left alone
//      with a `reason: "not-libi-installed"` log line. Revisions installed by
//      libi versions that predate the marker are therefore never pruned — that
//      is deliberate: without the marker they are indistinguishable from
//      another tool's, and leaving 500 MB behind beats deleting someone's
//      browser. The marker must be a REGULAR FILE (`isMarkerFile`): a symlink
//      there would let anything that exists stand in for libi's own stamp.
//
//   2. **The MobileCLIP export input — 572 MB.** `mcp/tracking/py/models.json`
//      calls it "export-time-only, NOT a runtime dep": the tracking installer
//      downloads `.build/mobileclip_blt.ts` purely to export `yoloe11.onnx` on
//      the user's machine, then leaves it. Once the ONNX and its
//      `.build-info.json` marker exist, the input is dead weight — and if the
//      pin ever changes, `ensureBuiltModel` re-downloads it from the sha-pinned
//      URL, so deleting it costs a re-fetch at worst, never correctness.
//
// Both are best-effort by construction: a directory that refuses to delete is
// logged and skipped — and `LIBI_SKIP_HOUSEKEEPING=1` turns the whole sweep off
// (see `SKIP_HOUSEKEEPING_ENV`), because code that deletes from a shared cache
// needs an off switch that is not "downgrade libi".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serverLogger as logger } from "@/lib/logger";
import { isMac, isWindows } from "@/lib/platform";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";
import { readPlaywrightBrowsersManifest } from "@/lib/playwright/paths";

const LOG_TAG = "lifecycle";
const LOG_OP = "prune";

/** Marker file at the root of a `<browser>-<revision>/` directory that libi
 *  installed itself. Only directories carrying it are ever pruned. */
export const LIBI_INSTALLED_MARKER = ".libi-installed";

/** Stamp a Playwright revision directory as libi-installed so a later boot may
 *  prune it once `playwright-core` moves on. Call it right after a successful
 *  `playwright install`, on the revision directory that install produced
 *  (`chromium-<rev>` and, when present, `chromium_headless_shell-<rev>`). The
 *  content is the ISO timestamp of the install; the file's presence is what the
 *  prune reads. Throws if `dir` does not exist — an install that produced no
 *  directory has nothing to mark. */
export function markLibiInstalled(dir: string): void {
  fs.writeFileSync(path.join(dir, LIBI_INSTALLED_MARKER), new Date().toISOString());
}

/** Mark every `<browser>-<revision>` directory that exists under the Playwright
 *  cache as libi-installed, and return the ones marked. Derives the directory
 *  names here so the installers do not re-derive them. `browsers` defaults to
 *  the full chromium only: libi installs with `--no-shell`, so a
 *  `chromium_headless_shell-<rev>` sitting beside it belongs to some other
 *  tool, and claiming it would let the prune delete that tool's browser.
 *  Pass it explicitly when an install genuinely fetched it. A missing
 *  directory is skipped, never an error — the caller is on an install's
 *  success path and must not turn a working install into a failure. */
export function markLibiInstalledRevisions(
  revision: string,
  browsers: string[] = ["chromium"],
): string[] {
  const cacheDir = playwrightCacheDir();
  const marked: string[] = [];
  for (const browser of browsers) {
    const dir = path.join(cacheDir, `${browser}-${revision}`);
    if (!fs.existsSync(dir)) continue;
    markLibiInstalled(dir);
    marked.push(dir);
  }
  return marked;
}

export interface PruneOutcome {
  removed: string[];
  kept: string[];
}

/**
 * Is `marker` a REGULAR FILE?
 *
 * `existsSync` follows symlinks, so a `.libi-installed` symlink pointing at any
 * file that happens to exist would answer "yes" and hand the prune permission
 * to `rm -rf` a revision libi does not own — the precise failure the marker
 * exists to prevent, in a cache every Playwright user on the machine writes
 * into. `lstatSync` resolves nothing: a symlink is a symlink, not a marker.
 * A directory named `.libi-installed` is not one either.
 */
function isMarkerFile(marker: string): boolean {
  try {
    return fs.lstatSync(marker).isFile();
  } catch {
    return false;
  }
}

/** Playwright's per-platform browser cache root, mirroring
 *  `playwright-core/lib/server/registry/index.js`'s `defaultRegistryDirectory`.
 *  `PLAYWRIGHT_BROWSERS_PATH` is honoured for the same reason Playwright honours
 *  it — and it is also how a verification run points the sweep at a scratch
 *  directory instead of the real cache. */
export function playwrightCacheDir(): string {
  // `os.homedir()`, not `process.env.HOME ?? process.env.USERPROFILE ?? ""`:
  // with neither variable set (a launchd/systemd unit, a service account, a
  // Finder-launched .app on a stripped environment) that fallback is the EMPTY
  // string, and every path below becomes RELATIVE to whatever `process.cwd()`
  // happens to be — a sweep that deletes directories must never be pointed by
  // an unset variable. `os.homedir()` reads the passwd entry / USERPROFILE and
  // is what the rest of the codebase uses.
  const home = os.homedir();
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  // isMac()/isWindows(), not `process.platform === …`: this module is now
  // reachable from a Next route (export → ensure-chromium → installers), and
  // a literal comparison there would be folded at build time.
  if (isMac()) {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  if (isWindows()) {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright");
}

/** The chromium revisions this `playwright-core` can actually launch, read from
 *  its own `browsers.json` (today: "1217" for chromium and the headless shell,
 *  "1417" for the tip-of-tree pair nothing installs). Read, never hardcoded — a
 *  `playwright-core` bump must move the keep set on its own or the next boot
 *  deletes the browser in use.
 *
 *  The manifest is read by `lib/playwright/paths.ts` beside `cli.js`, NOT via
 *  `require.resolve("playwright-core/browsers.json")`: the package's `exports`
 *  map does not expose that file, so the resolve throws
 *  (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and the sweep would silently never run. */
export function pinnedChromiumRevisions(): string[] {
  try {
    const revisions = readPlaywrightBrowsersManifest()
      .filter((b) => b.name.startsWith("chromium"))
      .map((b) => b.revision);
    return Array.from(new Set(revisions));
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: LOG_OP, err },
      "could not read playwright-core's browsers.json; keeping every revision",
    );
    return [];
  }
}

/** Chromium revision directories other than the pinned ones, and only those
 *  carrying `LIBI_INSTALLED_MARKER` — the cache is shared (see the module
 *  docblock). Only `chromium*` entries are considered — ffmpeg, firefox and
 *  webkit revisions are Playwright's to manage and libi installs none of them. */
export function pruneStalePlaywrightRevisions(
  opts: { cacheDir?: string; pinnedRevisions?: string[] } = {},
): PruneOutcome {
  const cacheDir = opts.cacheDir ?? playwrightCacheDir();
  const pinned = opts.pinnedRevisions ?? pinnedChromiumRevisions();
  // An empty keep-set means we could not read the manifest. Deleting every
  // revision then would remove the one in use, so do nothing at all.
  if (pinned.length === 0) return { removed: [], kept: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch (err) {
    // "The cache does not exist" (the common case — nothing to reclaim) and
    // "the cache exists and could not be read" (a permissions problem worth
    // knowing about) both land here and both return the same empty outcome.
    // Say which one happened, or "reclaimed nothing" is unfalsifiable.
    logger.debug(
      { tag: LOG_TAG, op: LOG_OP, dir: cacheDir, err },
      "could not read the Playwright browser cache; nothing was pruned",
    );
    return { removed: [], kept: [] };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^(chromium(?:[-_][a-z_]+)*)-(\d+)$/.exec(entry.name);
    if (!m) continue;
    const full = path.join(cacheDir, entry.name);
    if (pinned.includes(m[2]!)) {
      kept.push(full);
      continue;
    }
    if (!isMarkerFile(path.join(full, LIBI_INSTALLED_MARKER))) {
      kept.push(full);
      logger.info(
        { tag: LOG_TAG, op: LOG_OP, dir: full, reason: "not-libi-installed" },
        "left a stale Playwright revision alone: not installed by libi",
      );
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
      logger.info(
        { tag: LOG_TAG, op: LOG_OP, dir: full },
        "removed a stale Playwright browser revision",
      );
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: LOG_OP, dir: full, err },
        "could not remove a stale Playwright revision",
      );
    }
  }
  return { removed, kept };
}

/** `<models>/.build/` once `yoloe11.onnx` + its `.build-info.json` marker are
 *  both present. Both, not either: the ONNX alone can be a half-written file
 *  from an interrupted export, and the marker is what `ensureBuiltModel` writes
 *  LAST (`mcp/registry/installers/tracking-pyenv.ts`). */
export function pruneTrackingBuildInputs(
  opts: { modelsDir?: string } = {},
): PruneOutcome {
  const modelsDir = opts.modelsDir ?? trackingModelsDir();
  const buildDir = path.join(modelsDir, ".build");
  const onnx = path.join(modelsDir, "yoloe11.onnx");
  const marker = `${onnx}.build-info.json`;
  if (!fs.existsSync(buildDir)) return { removed: [], kept: [] };
  if (!fs.existsSync(onnx) || !fs.existsSync(marker)) {
    return { removed: [], kept: [buildDir] };
  }
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    logger.info(
      { tag: LOG_TAG, op: LOG_OP, dir: buildDir },
      "removed the tracking export's build inputs",
    );
    return { removed: [buildDir], kept: [] };
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: LOG_OP, dir: buildDir, err },
      "could not remove the tracking export's build inputs",
    );
    return { removed: [], kept: [buildDir] };
  }
}

/** One named sweep: a label for the log and a function that reclaims. */
export type HousekeepingSweep = readonly [what: string, sweep: () => PruneOutcome];

export interface BootHousekeepingOptions {
  /**
   * The sweeps to run. Defaults to the real pair. Injectable so a test can
   * assert the isolation contract (one sweep throwing must not skip the next)
   * without having to make a real `fs.rmSync` fail.
   */
  sweeps?: readonly HousekeepingSweep[];
  /** Playwright cache root for the default playwright sweep — a scratch dir in
   *  tests, so the sweep never reads the developer's real browser cache. */
  cacheDir?: string;
  /** Models root for the default tracking sweep, same reasoning as `cacheDir`. */
  modelsDir?: string;
}

/**
 * The env var that turns boot housekeeping off entirely.
 *
 * Both sweeps DELETE, and one of them deletes out of a cache shared with every
 * other Playwright user on the machine. The marker gate makes that safe by
 * construction, but "safe by construction" is what every deletion bug was
 * before it shipped — so there is an escape hatch that does not require
 * downgrading libi. `LIBI_SKIP_HOUSEKEEPING=1` (like `LIBI_HOME`,
 * `LIBI_TEST_MODE`, `LIBI_CDP` and `LIBI_NO_DEVTOOLS`) is read once, at the
 * sweep, and costs a user nothing but the disk the sweep would have reclaimed.
 */
export const SKIP_HOUSEKEEPING_ENV = "LIBI_SKIP_HOUSEKEEPING";

/** Both sweeps, each isolated so one failure cannot skip the other. */
export async function runBootHousekeeping(
  opts: BootHousekeepingOptions = {},
): Promise<void> {
  if (process.env[SKIP_HOUSEKEEPING_ENV] === "1") {
    logger.info(
      { tag: LOG_TAG, op: LOG_OP, skipped: true, env: SKIP_HOUSEKEEPING_ENV },
      `boot housekeeping skipped: ${SKIP_HOUSEKEEPING_ENV}=1`,
    );
    return;
  }
  const sweeps: readonly HousekeepingSweep[] = opts.sweeps ?? [
    [
      "playwright_revisions",
      () =>
        pruneStalePlaywrightRevisions(
          opts.cacheDir === undefined ? {} : { cacheDir: opts.cacheDir },
        ),
    ],
    [
      "tracking_build_inputs",
      () =>
        pruneTrackingBuildInputs(
          opts.modelsDir === undefined ? {} : { modelsDir: opts.modelsDir },
        ),
    ],
  ];
  for (const [what, sweep] of sweeps) {
    try {
      const { removed } = sweep();
      if (removed.length > 0) {
        logger.info(
          { tag: LOG_TAG, op: LOG_OP, what, count: removed.length, paths: removed },
          `reclaimed ${removed.length} ${what} path(s)`,
        );
      }
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: LOG_OP, what, err },
        `${what} sweep threw; nothing was reclaimed`,
      );
    }
  }
}
