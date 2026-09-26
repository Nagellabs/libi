// lib/uv-env/python-prefetch.ts
//
// Fetch libi's own Python in the background, before a feature needs it.
//
// Every uv call runs on a uv-managed CPython only (spawn-env.ts
// UV_PYTHON_PREFERENCE), so the first uv feature after an upgrade — Whisper,
// Kokoro, the music models, tracking, yt-dlp — has to download one (~25 MB)
// before it can start, and offline it fails, if plainly (network-failure.ts).
// Doing that download once, early, while the machine is most likely online,
// turns the offline failure into a working feature for everything whose
// packages are already in the uv cache.
//
// Best-effort by construction: it runs only when uv is already installed (it
// never installs uv), a few seconds after boot rather than inside it, once
// per Python version (a marker under `<LIBI_HOME>/uv/`), and a failure is a
// log line and nothing else — the next boot tries again. `--no-bin` keeps uv
// from linking `python3.x` into the user's `~/.local/bin`, which a plain
// `uv python install` does; `--no-registry` keeps it out of the Windows
// registry (PEP 514). Both verified with uv 0.11.32 on 2026-09-25. A uv too
// old to know those flags refuses the command; that is remembered per uv
// binary, so it is not retried every boot (an updated uv is tried again).
//
// Not in test mode, nor with the test routes on (e2e, skill-eval): those boot
// fresh homes and would download ~25 MB each time. A download still running
// when libi quits is killed.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { resolveUvBinary } from "@/lib/uv-path";
import { buildUvEnv, trackingVenvDir, uvPythonInstallDir, uvStateRoot } from "@/lib/uv-env/spawn-env";
import { describeUvNetworkFailure } from "@/lib/uv-env/network-failure";

/** The Python whisper, Kokoro, ACE-Step, music analysis and yt-dlp run on
 *  (`--python 3.12` at each call site; a drift test pins them to this). */
export const LIBI_PYTHON_VERSION = "3.12";

/** The tracking sidecar's Python (`mcp/tracking/py/.python-version`). */
export const TRACKING_PYTHON_VERSION = "3.11";

/** How long after boot the prefetch starts — past the busy start-up window. */
export const PYTHON_PREFETCH_DELAY_MS = 60_000;

/** A Python download that takes longer than this has stalled. */
const PREFETCH_TIMEOUT_MS = 5 * 60_000;

/** The versions worth fetching on this machine: 3.12 always (yt-dlp and the
 *  audio features all use it); 3.11 only where the tracking engine has been
 *  installed, since nothing else needs it and it is another ~70 MB. */
export function pythonVersionsToPrefetch(): string[] {
  const versions = [LIBI_PYTHON_VERSION];
  if (fs.existsSync(trackingVenvDir())) versions.push(TRACKING_PYTHON_VERSION);
  return versions;
}

/** `<LIBI_HOME>/uv/python-prefetched-<version>` — written after a successful fetch. */
export function pythonPrefetchMarker(version: string): string {
  return path.join(uvStateRoot(), `python-prefetched-${version}`);
}

/** `<LIBI_HOME>/uv/python-prefetch-unsupported` — the uv binary (path, size,
 *  mtime) that refused `--no-bin`/`--no-registry`; that uv is not asked again. */
export function pythonPrefetchUnsupportedMarker(): string {
  return path.join(uvStateRoot(), "python-prefetch-unsupported");
}

function uvIdentity(uv: string): string | null {
  try {
    const st = fs.statSync(uv);
    return JSON.stringify({ uv, size: st.size, mtimeMs: st.mtimeMs });
  } catch {
    return null;
  }
}

/** uv's clap error for a flag it does not know (uv < 0.8 and `--no-bin`). */
const UNKNOWN_FLAG_RE = /unexpected argument '--no-(bin|registry)'/;

/** Run `uv python install`, killing the child if libi exits first. */
function runPythonInstall(uv: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      uv,
      ["python", "install", version, "--no-bin", "--no-registry"],
      {
        timeout: PREFETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: buildUvEnv({ NO_COLOR: "1" }),
      },
      (err, _stdout, stderr) => {
        process.off("exit", killChild);
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve();
      },
    );
    function killChild() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    // `exit` is the one hook every surface reaches on the way out (npx
    // Ctrl-C via Category B's signal handler, the packaged app's quit); a kill
    // is synchronous, which is all it allows.
    process.on("exit", killChild);
  });
}

/** The marker is there AND the interpreter still is (uv names its dirs
 *  `cpython-<version>.<patch>-<platform>`): a cleared `uv/python` is fetched again. */
function alreadyPrefetched(version: string): boolean {
  if (!fs.existsSync(pythonPrefetchMarker(version))) return false;
  try {
    return fs.readdirSync(uvPythonInstallDir()).some((name) => name.startsWith(`cpython-${version}.`));
  } catch {
    return false;
  }
}

export type PrefetchOutcome = "fetched" | "already" | "failed";

/**
 * Fetch each version libi needs that is not already here. Never throws.
 * `uv` is injectable for tests; by default it is the uv the features use
 * (libi's `bin/uv`, else one on PATH), and without one nothing happens.
 */
export async function prefetchManagedPython(
  opts: { uv?: string | null; versions?: string[] } = {},
): Promise<Record<string, PrefetchOutcome> | null> {
  const uv = opts.uv === undefined ? resolveUvBinary() : opts.uv;
  if (!uv) {
    logger.debug({ tag: "uv-env", op: "python_prefetch_skipped", reason: "no_uv" }, "uv is not installed; not prefetching Python");
    return null;
  }
  const identity = uvIdentity(uv);
  try {
    if (identity && fs.readFileSync(pythonPrefetchUnsupportedMarker(), "utf-8") === identity) {
      logger.debug(
        { tag: "uv-env", op: "python_prefetch_skipped", reason: "uv_too_old" },
        "this uv does not support --no-bin; not prefetching Python",
      );
      return null;
    }
  } catch {
    /* no marker */
  }
  const outcomes: Record<string, PrefetchOutcome> = {};
  for (const version of opts.versions ?? pythonVersionsToPrefetch()) {
    if (alreadyPrefetched(version)) {
      outcomes[version] = "already";
      continue;
    }
    const started = Date.now();
    try {
      await runPythonInstall(uv, version);
      fs.mkdirSync(uvStateRoot(), { recursive: true });
      fs.writeFileSync(pythonPrefetchMarker(version), `${new Date().toISOString()}\n`);
      outcomes[version] = "fetched";
      logger.info(
        { tag: "uv-env", op: "python_prefetched", version, durationMs: Date.now() - started },
        `libi's Python ${version} is ready`,
      );
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      outcomes[version] = "failed";
      if (identity && UNKNOWN_FLAG_RE.test(stderr)) {
        try {
          fs.mkdirSync(uvStateRoot(), { recursive: true });
          fs.writeFileSync(pythonPrefetchUnsupportedMarker(), identity);
        } catch {
          /* best-effort: then it is simply tried again next boot */
        }
      }
      logger.info(
        {
          tag: "uv-env",
          op: "python_prefetch_failed",
          version,
          offline: describeUvNetworkFailure("prefetch", stderr) !== null,
          err: (err as Error).message.slice(0, 500),
          stderr: stderr.slice(-1000),
        },
        "could not prefetch libi's Python; the first feature that needs it will download it",
      );
    }
  }
  return outcomes;
}

/**
 * Start the prefetch `delayMs` after boot, once per process (Next can load
 * this module twice). The timer does not hold the process open. Not under
 * `LIBI_TEST_MODE`, nor with the test routes on (e2e / skill-eval runs).
 */
export function schedulePythonPrefetch(delayMs: number = PYTHON_PREFETCH_DELAY_MS): void {
  if (isTestMode() || testRoutesEnabled()) {
    logger.debug({ tag: "uv-env", op: "python_prefetch_skipped", reason: "test_mode" }, "test mode; not prefetching Python");
    return;
  }
  const g = globalThis as { __libiPythonPrefetchScheduled?: boolean };
  if (g.__libiPythonPrefetchScheduled) return;
  g.__libiPythonPrefetchScheduled = true;
  const timer = setTimeout(() => {
    void prefetchManagedPython();
  }, delayMs);
  timer.unref?.();
}
