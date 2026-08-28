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
 * up here at install time. This file is imported only by
 * `dependency-manager.ts` (server-only), so it stays out of the client bundle.
 */

import fs from "fs";
import path from "path";
import type { CustomInstaller } from "./types";
import { trackingPyenvInstaller } from "./installers/tracking-pyenv";
import { isWindows } from "@/lib/platform";

/**
 * Force-rebuild lever for the uv-managed yt-dlp install. Custom-installer deps
 * don't participate in the standard `pinnedInstallToken` marker mechanism
 * (`tokenMarkerPath` returns null for them), so yt-dlp would otherwise never
 * upgrade once its `~/.libi/bin/yt-dlp` wrapper exists — leaving users stuck on
 * a stale binary (yt-dlp breaks fast when YouTube changes its player /
 * JS-challenge scheme). This token is written to `~/.libi/bin/yt-dlp.install-token`
 * after every install and re-read by `verify()`; bumping it (typically to
 * today's date) makes `verify()` return null on the next boot → a one-time
 * `uv tool install yt-dlp --reinstall` that pulls the current upstream release.
 * Mirrors `TRACKING_PYENV_TOKEN` in `installers/tracking-pyenv.ts`.
 */
export const YT_DLP_UV_TOKEN = "yt-dlp-uv@2026-07-06";

/**
 * Sentinel `command` meaning "a real Node.js interpreter, resolved at install
 * time via `resolveNodeCommand()`".
 *
 * NEVER put `process.execPath` in an install spec: under the packaged app it
 * is the Electron binary, and `electronFuses.runAsNode: false` makes it ignore
 * ELECTRON_RUN_AS_NODE, so it launches a second Libi GUI instead of running
 * the intended Node program.
 */
export const NODE_COMMAND_SENTINEL = "__NODE__";

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
  "playwright-chromium": {
    verify: async () => {
      try {
        const { chromium } = await import("playwright-core");
        const p = chromium.executablePath();
        return fs.existsSync(p) ? p : null;
      } catch {
        return null;
      }
    },
    install: {
      // A REAL node — never `process.execPath`.
      //
      // Under the packaged app `process.execPath` is the Electron binary, and
      // `electronFuses.runAsNode: false` makes it ignore ELECTRON_RUN_AS_NODE
      // — so spawning it here launches a second full Libi GUI instead of
      // running Playwright's CLI. chromium is a tier-1 dep on the core def, so
      // Category A hard-fails and the app never boots.
      //
      // This did not surface in QA only because `verify()` short-circuits when
      // Playwright's global cache is already warm from dev work; a user with a
      // cold `~/Library/Caches/ms-playwright` would have hit it on first boot.
      //
      // Same bug class as `lib/install/npm-root.ts`, the storyboard render
      // worker, and `fetchElectronPrebuild`. `resolveNodeCommand()` is the
      // established answer — see `lib/runtime/node-runtime.ts`.
      // Sentinel, not a direct `resolveNodeCommand()` call: `install` is a
      // module-level literal, so calling it here would freeze the answer at
      // import time — before Category A has provisioned `<LIBI_HOME>/bin/node`.
      // DependencyManager.runCustomInstaller resolves it at install time,
      // mirroring the __PLAYWRIGHT_CORE_CLI__ arg sentinel below.
      command: NODE_COMMAND_SENTINEL,
      args: [
        // Resolved at runtime by DependencyManager.runCustomInstaller —
        // see the comment there for why we don't bake the path in here.
        "__PLAYWRIGHT_CORE_CLI__",
        "install",
        "chromium",
      ],
      timeoutMs: 10 * 60_000, // 10 min — first install downloads ~165 MB
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
   * we list `uv` before `yt-dlp` on the youtube-downloader def.
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

export function getCustomInstaller(id: string): CustomInstaller | undefined {
  return INSTALLERS[id];
}

/** Walk up from cwd to find `node_modules/playwright-core/cli.js`. Server-only. */
export function resolvePlaywrightCoreCli(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", "playwright-core", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate node_modules/playwright-core/cli.js relative to cwd. " +
      "Ensure playwright-core is installed.",
  );
}
