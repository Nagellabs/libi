/**
 * The ONE place that decides where uv-managed state lives, and the ONE way a
 * uv subprocess is spawned.
 *
 * ## Why this exists
 *
 * Left to its defaults, `uv` writes to the *user's* home, not libi's:
 *
 *   - `~/.cache/uv`            — wheels, sdists, git checkouts, and the
 *                                ephemeral `uv run --with …` environments.
 *                                Measured at 2.6 GB on a dev machine, almost
 *                                all of it torch pulled in by libi's whisper /
 *                                Kokoro / ACE-Step runners.
 *   - `~/.local/share/uv`      — managed CPython interpreters + `uv tool`
 *                                installs (yt-dlp).
 *   - `<project>/.venv`        — the project environment for `uv sync`.
 *
 * The last one is the dangerous default. The tracking sidecar's project dir is
 * `mcp/tracking/py/` INSIDE the shipped package, so `uv sync` planted a 1.2 GB
 * venv inside the signed `.app`
 * (`Resources/libi-bundle/node_modules/@nagellabs/libi/mcp/tracking/py/.venv`)
 * — breaking the code signature and failing outright on a read-only install.
 * The packaged app's own directory must be treated as READ-ONLY.
 *
 * The other two are not a signing break, but they leak multi-gigabyte,
 * libi-created state into the user's personal uv cache where it cannot be
 * attributed to libi and survives uninstalling it.
 *
 * So: every uv invocation in libi routes through `buildUvEnv()`, which pins all
 * four locations under `<LIBI_HOME>/uv/`. Because the paths are computed from
 * `getLibiHome()` alone, dev, the packaged Electron app, and `npx
 * @nagellabs/libi` all resolve through this single code path with no
 * per-environment branching.
 *
 * ## Sharing across worktrees
 *
 * A git worktree gets its own `LIBI_HOME` (`~/.libi/worktrees/<name>/`), which
 * would naively mean re-downloading gigabytes of torch per worktree.
 * `lib/dev/worktree-bootstrap.ts` already solves exactly this for `bin`,
 * `models` and `node_modules` by symlinking them to the canonical `~/.libi`,
 * and `"uv"` is registered in that same `SHARED_LINKS` list. So there is one uv
 * state tree per machine, libi owns it, and `rm -rf ~/.libi` reclaims all of
 * it — without inventing a second sharing mechanism.
 */

import path from "node:path";
import { getLibiBinDir, getLibiHome } from "@/lib/libi-home";

/** Root of every uv-managed artifact libi creates. */
export function uvStateRoot(): string {
  return path.join(getLibiHome(), "uv");
}

/** `UV_CACHE_DIR` — wheels, sdists, and `uv run --with` ephemeral envs. */
export function uvCacheDir(): string {
  return path.join(uvStateRoot(), "cache");
}

/** `UV_PYTHON_INSTALL_DIR` — uv-managed CPython interpreters. */
export function uvPythonInstallDir(): string {
  return path.join(uvStateRoot(), "python");
}

/** `UV_TOOL_DIR` — `uv tool install` root (yt-dlp). */
export function uvToolDir(): string {
  return path.join(uvStateRoot(), "tools");
}

/** `UV_TOOL_BIN_DIR` — entry points written by `uv tool install`. */
export function uvToolBinDir(): string {
  return path.join(uvStateRoot(), "tools-bin");
}

/**
 * `PYTHONPYCACHEPREFIX` — where CPython writes `.pyc` files.
 *
 * Python's default is a `__pycache__/` directory NEXT TO THE SOURCE. Every
 * Python entry point libi runs (`mcp/tracking/py/track_runner.py`,
 * `mcp/whisper/transcribe.py`, `mcp/tts/synthesize.py`, `mcp/music/*.py`)
 * lives in the shipped package, so the default silently writes into the signed
 * `.app` — the same defect class as the venv, just smaller. The `__pycache__`
 * exclusion in `package.json`'s `files` list is evidence these were being
 * created in-tree.
 *
 * Redirecting (rather than disabling via PYTHONDONTWRITEBYTECODE) keeps the
 * bytecode cache, so a large dependency tree like torch is not recompiled on
 * every run.
 */
export function pythonPycachePrefix(): string {
  return path.join(uvStateRoot(), "pycache");
}

/**
 * `YOLO_CONFIG_DIR` — ultralytics' settings/assets directory.
 *
 * Ultralytics (loaded by the tracking sidecar's YOLOE detector) falls back
 * through `~/Library/Application Support/Ultralytics` → `/tmp/Ultralytics` →
 * `Path.cwd()/Ultralytics`, and its `weights_dir` / `runs_dir` defaults are
 * cwd-RELATIVE. The sidecar's cwd is the shipped package, so an asset download
 * or a config-dir fallback would write into the signed `.app`. No such write
 * fires today (libi passes absolute model paths), which makes this latent
 * rather than active — pinned here so it stays that way.
 */
export function yoloConfigDir(): string {
  return path.join(uvStateRoot(), "ultralytics");
}

/**
 * `UV_PROJECT_ENVIRONMENT` for the tracking sidecar (`mcp/tracking/py`).
 *
 * This is the venv that used to land inside the package. It is keyed by
 * project, not by caller, so `uv sync` (the installer) and `uv run` (the
 * runners + selftest) all address the same environment.
 */
export function trackingVenvDir(): string {
  return path.join(uvStateRoot(), "envs", "tracking");
}

/**
 * The `UV_*` variables that redirect uv away from the user's home.
 *
 * These deliberately OVERRIDE any inherited value: a stray `UV_CACHE_DIR` in
 * the user's shell must not silently relocate libi's state and reintroduce the
 * drift this module exists to remove.
 */
export function uvEnvVars(): Record<string, string> {
  return {
    UV_CACHE_DIR: uvCacheDir(),
    UV_PYTHON_INSTALL_DIR: uvPythonInstallDir(),
    UV_TOOL_DIR: uvToolDir(),
    UV_TOOL_BIN_DIR: uvToolBinDir(),
  };
}

/**
 * Build the environment for a uv subprocess.
 *
 * Inherits `process.env` (uv and the Python it spawns need HOME, TMPDIR, LANG,
 * proxy vars, …), prepends `<LIBI_HOME>/bin` to PATH so uv-spawned children
 * find libi's ffmpeg/uv/node, then pins the `UV_*` locations.
 *
 * `extra` is layered last so a caller can add job-specific variables
 * (`UV_PROJECT_ENVIRONMENT`, `LIBI_TRACK_MODELS`, `NO_COLOR`, …).
 *
 * ALL uv spawns must go through this — see
 * `__tests__/unit/uv-env/install-path-invariants.test.ts`, which fails the
 * build if a new `uv` spawn site forgets it.
 */
export function buildUvEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  // Built by mutating a spread of `process.env` rather than assembled as one
  // object literal. `NodeJS.ProcessEnv` is augmented in this project to
  // REQUIRE `NODE_ENV`, so a fresh literal — however complete at runtime —
  // cannot satisfy the type, which is why this used to end in an
  // `as NodeJS.ProcessEnv` that did not actually typecheck. Spreading
  // `process.env` carries that required key through, so no cast is needed and
  // nothing is silenced.
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Drop non-string values so the result is a clean string map, matching what
  // every spawn call site expects to hand to child_process.
  for (const key of Object.keys(env)) {
    if (typeof env[key] !== "string") delete env[key];
  }

  const pathSep = process.platform === "win32" ? ";" : ":";
  env.PATH = `${getLibiBinDir()}${pathSep}${process.env.PATH ?? ""}`;

  Object.assign(env, uvEnvVars(), {
    // Keeps CPython from writing bytecode next to the shipped .py sources.
    PYTHONPYCACHEPREFIX: pythonPycachePrefix(),
    // Harmless to processes that never load ultralytics; set on the shared
    // seam rather than the three tracking spawns so it cannot drift.
    YOLO_CONFIG_DIR: yoloConfigDir(),
  });
  Object.assign(env, extra);

  return env;
}
