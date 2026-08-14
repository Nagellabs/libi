/**
 * Probe + activate the REAL, provisioned tracking sidecar environment.
 *
 * ## Why this exists
 *
 * The vitest global setup (`__tests__/setup/isolate-libi-home.ts`) repoints
 * `LIBI_HOME` at a per-run temp dir so tests can never touch the developer's
 * real `~/.libi`. Everything the uv-managed Python sidecar needs is derived
 * from `getLibiHome()`:
 *
 *   - `uvPath()`        → `<LIBI_HOME>/bin/uv`   (falls back to bare `"uv"`)
 *   - `trackingVenvDir()` → `<LIBI_HOME>/uv/envs/tracking`
 *   - `trackingModelsDir()` → `<LIBI_HOME>/models/tracking`
 *
 * Under the isolated home none of those exist, so the sidecar tests died with
 * `spawn uv ENOENT`. Worse, had uv been found, `uv run` would have tried to
 * BUILD the ~1.2 GB torch venv at `<temp>/uv/envs/tracking` — a multi-gigabyte
 * download triggered by a unit-test run. That must never happen.
 *
 * So: probe the real home for a genuinely provisioned environment first, and
 * only when everything is already on disk point the run at it (the same shape
 * as `engine-runner.test.ts`'s existing `LIBI_TRACK_MODELS` override, widened
 * to the whole home because uv + the venv are derived from it too). When
 * anything is missing the caller skips with the exact reason.
 *
 * Nothing here provisions, installs, or syncs anything.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The developer's REAL libi home, resolved the same way `getLibiHome()` does
 * MINUS the `LIBI_HOME` env var (which the vitest global setup owns).
 */
export function realLibiHome(): string {
  const defaultHome = path.join(os.homedir(), ".libi");
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(defaultHome, "config.json"), "utf-8"),
    ) as { libiHome?: unknown };
    if (typeof config.libiHome === "string" && config.libiHome) {
      return config.libiHome;
    }
  } catch {
    /* no config.json — use the default */
  }
  return defaultHome;
}

const isWin = process.platform === "win32";

/** `<realHome>/bin/uv`, or a `uv` found on PATH, or null when neither exists. */
function findUv(home: string): string | null {
  const bundled = path.join(home, "bin", isWin ? "uv.exe" : "uv");
  if (fs.existsSync(bundled)) return bundled;

  // `uvPath()` falls back to the bare string "uv", which only works when uv is
  // on PATH. Resolve that here rather than discovering it via ENOENT.
  for (const dir of (process.env.PATH ?? "").split(isWin ? ";" : ":")) {
    if (!dir) continue;
    const candidate = path.join(dir, isWin ? "uv.exe" : "uv");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The interpreter `uv run` would use — proof the venv is really built. */
function venvPython(venvDir: string): string {
  return isWin
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

export interface TrackingEnvProbe {
  /** `null` when provisioned; otherwise a human-readable reason to skip. */
  missing: string | null;
  /** The real libi home the probe inspected. */
  home: string;
  /** Resolved uv binary, when found. */
  uv: string | null;
  /** `<home>/uv/envs/tracking` — must already contain a python interpreter. */
  venvDir: string;
  /** `<home>/models/tracking` — the ONNX artifacts. */
  modelsDir: string;
}

/**
 * Is the tracking sidecar environment actually provisioned on this machine?
 *
 * @param opts.requireModels also require the ONNX model artifacts (needed to
 *   run a real segment; the `--selftest` entry point only imports libraries).
 */
export function probeTrackingEnv(
  opts: { requireModels?: boolean } = {},
): TrackingEnvProbe {
  const home = realLibiHome();
  const venvDir = path.join(home, "uv", "envs", "tracking");
  const modelsDir = path.join(home, "models", "tracking");
  const uv = findUv(home);

  const probe: TrackingEnvProbe = { missing: null, home, uv, venvDir, modelsDir };

  if (!uv) {
    probe.missing = `uv not found — no ${path.join(home, "bin", "uv")} and no uv on PATH`;
    return probe;
  }

  // Existence of the interpreter (not just the directory) is what proves the
  // venv is built. A bare/partial directory would make `uv run` start syncing.
  if (!fs.existsSync(venvPython(venvDir))) {
    probe.missing =
      `tracking python env not provisioned — ${venvPython(venvDir)} missing ` +
      `(run libi once so the tracking-pyenv installer syncs it; refusing to build a ~1.2 GB venv from a test)`;
    return probe;
  }

  if (opts.requireModels) {
    const onnx = (() => {
      try {
        return fs.readdirSync(modelsDir).filter((f) => f.endsWith(".onnx"));
      } catch {
        return [];
      }
    })();
    if (onnx.length === 0) {
      probe.missing = `tracking ONNX models not installed — no *.onnx under ${modelsDir}`;
      return probe;
    }
  }

  return probe;
}

/**
 * Point the process at the real, provisioned tracking environment for the
 * duration of a test file. Returns a restore function for `afterAll`.
 *
 * `LIBI_HOME` is what `uvPath()` / `trackingVenvDir()` / `trackingModelsDir()`
 * all derive from, so it is the single switch that makes the sidecar resolve
 * the provisioned uv binary, the already-built venv, and the real models.
 * `LIBI_TRACK_MODELS` is set explicitly too, mirroring the override the
 * sidecar runners already honour.
 *
 * Only call this when `probeTrackingEnv().missing === null`.
 */
export function useRealTrackingEnv(probe: TrackingEnvProbe): () => void {
  const savedHome = process.env.LIBI_HOME;
  const savedModels = process.env.LIBI_TRACK_MODELS;

  process.env.LIBI_HOME = probe.home;
  process.env.LIBI_TRACK_MODELS = probe.modelsDir;

  return () => {
    if (savedHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = savedHome;

    if (savedModels === undefined) delete process.env.LIBI_TRACK_MODELS;
    else process.env.LIBI_TRACK_MODELS = savedModels;
  };
}
