/**
 * Server-only registry of `CustomInstaller` implementations.
 *
 * `bundled.ts` is reachable from client components (the Settings UI shows
 * MCP cards built from `BUNDLED_MCP_SERVERS`), so we cannot embed
 * server-only imports (`fs`, `playwright-core`) directly in its
 * `customInstaller.verify` / `.install` closures — Turbopack will trace
 * those closures into the client bundle and explode on `Can't resolve 'tls'`.
 *
 * Instead, `bundled.ts` references installers by string ID via
 * `customInstallerId`, and `DependencyManager` looks the real implementation
 * up here at install time. This file is imported only from server code —
 * `dependency-manager.ts` and the export-time Chromium download
 * (`lib/export/ensure-chromium.ts`) — so it stays out of the client bundle.
 *
 * Playwright path helpers live in `lib/playwright/paths.ts` (a leaf), not
 * here: this file imports the boot prune's marker helper, and the prune reads
 * the same paths, so keeping them here was an import cycle.
 */

import fs from "fs";
import path from "path";
import type { CustomInstaller } from "./types";
import { trackingPyenvInstaller } from "./installers/tracking-pyenv";
import { isWindows } from "@/lib/platform";
import { serverLogger as logger } from "@/lib/logger";
import { markLibiInstalledRevisions } from "@/lib/server/lifecycle/housekeeping";
import { playwrightChromiumRevision } from "@/lib/playwright/paths";

/**
 * Force-rebuild lever for the uv-managed yt-dlp install. Custom-installer deps
 * don't participate in the standard `pinnedInstallToken` marker mechanism
 * (`tokenMarkerPath` returns null for them), so yt-dlp would otherwise never
 * upgrade once its `~/.libi/bin/yt-dlp` wrapper exists — leaving users stuck on
 * a stale binary (yt-dlp breaks fast when YouTube changes its player /
 * JS-challenge scheme). This token is written to `~/.libi/bin/yt-dlp.install-token`
 * after every install and re-read by `verify()`; bumping it (typically to
 * today's date) makes `verify()` return null on the next boot → a one-time
 * `uv tool install yt-dlp[default] --reinstall` that pulls the current upstream
 * release. Mirrors `TRACKING_PYENV_TOKEN` in `installers/tracking-pyenv.ts`.
 *
 * 2026-09-09: bumped because the requirement gained the `[default]` extra —
 * every EXISTING install is a bare `yt-dlp` with no `yt-dlp-ejs`, i.e. no
 * JS-challenge solver script, which is what throttles and eventually 403s a
 * large YouTube download. Only a re-install repairs those.
 */
export const YT_DLP_UV_TOKEN = "yt-dlp-uv@2026-09-09";

/**
 * The requirement uv installs — `yt-dlp[default]`, never bare `yt-dlp`.
 *
 * The `[default]` extra is what pulls **`yt-dlp-ejs`**, the external-JavaScript
 * challenge solver, at the version yt-dlp itself pins for that release
 * (`yt-dlp-ejs==0.8.0; extra == "default"` in 2026.8.19's metadata). Without it
 * a YouTube download prints
 *
 *     WARNING: [youtube] [jsc] Remote component challenge solver script (node)
 *              was skipped … --remote-components ejs:github (recommended)
 *     WARNING: [youtube] …: n challenge solving failed: Some formats may be missing
 *
 * and proceeds with UNSOLVED `n` parameters — which YouTube answers by
 * throttling the stream to a few hundred KiB/s and 403-ing when the URL is
 * refreshed part-way through a large file. Verified 2026-09-09 against a
 * 679 MiB video: both warnings and a 240 KiB/s average with a bare install,
 * neither warning with this one.
 *
 * The alternative yt-dlp suggests, `--remote-components ejs:github`, fetches
 * the same script over the network at DOWNLOAD time (and `ejs` alone is not a
 * valid value — only `ejs:npm` / `ejs:github` are). Shipping it inside the venv
 * keeps the install hermetic and the download offline-safe. The extra also
 * carries brotli/mutagen/pycryptodomex/requests/urllib3/websockets — upstream's
 * own recommended install — and certifi, which the `--with certifi` below still
 * names explicitly because the SSL_CERT_FILE discovery depends on it.
 *
 * Changing this string means every EXISTING install is wrong: bump
 * `YT_DLP_UV_TOKEN` in the same edit so `verify()` forces the re-install.
 */
export const YT_DLP_UV_REQUIREMENT = "yt-dlp[default]";

/** argv for the `uv tool install` that provisions yt-dlp (uv binary aside).
 *  `--reinstall` implies `--refresh`, so a token bump lands the CURRENT
 *  upstream release rather than no-opping on what is already there. */
export function ytDlpUvInstallArgs(): string[] {
  return [
    "tool",
    "install",
    YT_DLP_UV_REQUIREMENT,
    "--reinstall",
    "--python",
    "3.12",
    "--with",
    "certifi",
  ];
}

/** The `customInstallerId` of the Chromium dep on the `libi-export` def. */
export const PLAYWRIGHT_CHROMIUM_INSTALLER_ID = "playwright-chromium";

/**
 * Whole-command sentinel: "run `lib/export/ensure-chromium.ts`". Chromium has
 * exactly ONE install path — that module's streaming, single-flight spawn of
 * `playwright install chromium --no-shell` (with `--force` only for a Settings
 * Re-download). `DependencyManager.runCustomInstaller` dispatches this the
 * way it does `__TRACKING_PYENV_INSTALL__` / `__YT_DLP_UV_INSTALL__`.
 *
 * Why not a real command here: this declaration used to spell the same spawn
 * a second time (`__NODE__ cli.js install chromium --no-shell --force` via
 * `execFileAsync`), and the two ran outside each other's knowledge — a
 * Settings click during an export-driven download queued behind playwright's
 * `__dirlock` and then force-removed the revision the export was about to
 * launch. The node itself is resolved at install time by ensure-chromium
 * (`resolveNodeCommand()`, never `process.execPath` — under the packaged app
 * that is the Electron binary and would launch a second Libi GUI).
 */
export const ENSURE_CHROMIUM_INSTALL_SENTINEL = "__ENSURE_CHROMIUM__";

/** Path of the yt-dlp install-token marker, next to the `~/.libi/bin/yt-dlp` wrapper. */
export function ytDlpTokenPath(binDir: string): string {
  return path.join(binDir, "yt-dlp.install-token");
}

const INSTALLERS: Record<string, CustomInstaller> = {
  /**
   * Local tracking engine: `uv sync` the Python sidecar at
   * `mcp/tracking/py/` + provision the four ONNX model artifacts under
   * `~/.libi/models/tracking/`. Implementation lives in
   * `installers/tracking-pyenv.ts` (server-only). Like `yt-dlp-uv` this is
   * a multi-step install expressed via a sentinel `command`
   * (`__TRACKING_PYENV_INSTALL__`) that DependencyManager.runCustomInstaller
   * expands into the real logic.
   */
  "tracking-pyenv": trackingPyenvInstaller,
  [PLAYWRIGHT_CHROMIUM_INSTALLER_ID]: {
    verify: async () => {
      try {
        const { chromium } = await import("playwright-core");
        const p = chromium.executablePath();
        if (!fs.existsSync(p)) return null;
        // The executable alone is not "installed": it lands early in the zip,
        // so an install killed mid-extraction (timeout, cancel, crash) leaves a
        // launchable-looking path inside a broken bundle. Playwright's own
        // signal that extraction finished is `INSTALLATION_COMPLETE` at the
        // revision dir root (`browserDirectoryToMarkerFilePath` in
        // playwright-core/lib/server/registry/index.js); require it, or the
        // next export skips the download and launches the half-extracted app.
        return fs.existsSync(path.join(playwrightRevisionDir(p), "INSTALLATION_COMPLETE"))
          ? p
          : null;
      } catch {
        return null;
      }
    },
    // The command, its args (`--no-shell`, and `--force` for a Re-download
    // only) and the node that runs it all live in `lib/export/ensure-chromium.ts`
    // — see ENSURE_CHROMIUM_INSTALL_SENTINEL. `timeoutMs` documents the budget
    // that module enforces itself (INSTALL_TIMEOUT_MS).
    install: {
      command: ENSURE_CHROMIUM_INSTALL_SENTINEL,
      args: [],
      timeoutMs: 10 * 60_000, // 10 min — first install downloads ~173 MB (165 MiB)
    },
    // Stamp the revision dir the install produced as libi's, so the boot prune
    // (`lib/server/lifecycle/housekeeping.ts`) may reclaim it once
    // playwright-core moves on — it only ever removes revisions carrying that
    // marker, because the ms-playwright cache is shared with every other
    // Playwright user on the machine. Fired by `ensureChromium`, the one
    // install path. Best-effort by construction: this runs on a
    // SUCCESSFUL install, and a missing marker costs a stale 500 MB later,
    // whereas a throw here would turn a working Chromium into a failed export.
    onInstalled: () => {
      const revision = playwrightChromiumRevision();
      try {
        if (!revision) throw new Error("could not read playwright-core's browsers.json");
        const marked = markLibiInstalledRevisions(revision);
        if (marked.length === 0) {
          throw new Error(`no chromium-${revision} directory under the Playwright cache`);
        }
        logger.info(
          { tag: "export", op: "chromium_mark", marked },
          "marked the installed Chromium revision as libi's",
        );
      } catch (err) {
        logger.warn(
          { tag: "export", op: "chromium_mark", revision, err },
          "could not mark the installed Chromium revision; the boot prune will leave it alone",
        );
      }
    },
  },
  /**
   * yt-dlp installed via `uv tool install` instead of the 35 MB PyInstaller-
   * onefile binary published by upstream. The uv-managed install is a real
   * Python script — cold start ~150ms vs ~11s for the PyInstaller binary.
   * That difference matters because yt-dlp-mcp shells out to `yt-dlp` on
   * every spawn-side probe, and the PyInstaller cold start was racing the
   * MCP SDK's default 30s spawn timeout when several MCPs initialize in
   * parallel.
   *
   * The installer symlinks the uv-managed entry point into
   * `~/.libi/bin/yt-dlp` so the standard `~/.libi/bin` PATH augmentation
   * (see `mcp/registry/spawn-env.ts`) makes it visible to yt-dlp-mcp.
   *
   * Depends on `uv` being installed first — Category A's dep loop installs
   * deps in the order they appear in the MCP's `dependencies[]` array, so
   * we list `uv` before `yt-dlp` on the youtube-download def.
   */
  "yt-dlp-uv": {
    verify: async () => {
      const { getLibiBinDir } = await import("@/lib/libi-home");
      const binDir = getLibiBinDir();
      // Must match what the installer WRITES: the win32 branch of
      // `runCustomInstaller` writes a `yt-dlp.cmd` shim (symlinks need admin on
      // Windows), while Unix gets an extensionless shell wrapper. Checking the
      // extensionless name on Windows made verify() return null forever — the
      // install "succeeded" and was then declared failed, which aborted boot.
      const target = path.join(
        binDir,
        isWindows() ? "yt-dlp.cmd" : "yt-dlp",
      );
      // Use lstat so a broken symlink (e.g. uv-managed install was wiped)
      // counts as "not installed" — installing again recreates the link.
      try {
        fs.lstatSync(target);
      } catch {
        return null;
      }
      // Also confirm the symlink target resolves — broken symlinks should
      // re-install. realpathSync throws when the target is missing.
      try {
        fs.realpathSync(target);
      } catch {
        return null;
      }
      // Token gate: a wrapper written before the current YT_DLP_UV_TOKEN (or
      // with no token file at all — pre-token installs) is treated as stale so
      // a bump forces a one-time `--reinstall` to the latest yt-dlp.
      let token = "";
      try {
        token = fs.readFileSync(ytDlpTokenPath(binDir), "utf-8").trim();
      } catch {
        token = "";
      }
      if (token !== YT_DLP_UV_TOKEN) return null;
      return target;
    },
    install: {
      // Sentinels resolved at runtime by DependencyManager.runCustomInstaller.
      // This is a two-step install (uv tool install + symlink) so we use a
      // single sentinel that the runner expands into actual logic, mirroring
      // the __PLAYWRIGHT_CORE_CLI__ pattern.
      command: "__YT_DLP_UV_INSTALL__",
      args: [],
      timeoutMs: 5 * 60_000, // 5 min — uv may download python-build-standalone on first run
    },
  },
};

/** The `chromium-<rev>` directory an executable under the Playwright cache
 *  belongs to — walk up until a path segment matches a revision dir name.
 *  Falls back to the executable's own directory when nothing matches (the
 *  marker check then simply fails, which is the safe answer). */
function playwrightRevisionDir(executablePath: string): string {
  let dir = path.dirname(executablePath);
  for (let i = 0; i < 12; i++) {
    if (/^chromium(?:[-_][a-z_]+)*-\d+$/.test(path.basename(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(executablePath);
}

export function getCustomInstaller(id: string): CustomInstaller | undefined {
  return INSTALLERS[id];
}
