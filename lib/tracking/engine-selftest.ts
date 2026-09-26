/**
 * Engine selftest — drives the uv-managed Python sidecar's `--selftest`
 * entry point to confirm the tracking environment is synced and the core
 * inference libs import cleanly.
 *
 * Used by Category A (`lib/server/lifecycle/category-a.ts`) as a startup
 * gate: after the `tracking-pyenv` custom installer runs `uv sync` and
 * provisions the ONNX models, this verifies the env actually works before
 * the libi MCP is declared healthy.
 *
 * Invocation mirrors the working pattern proven in Task 9
 * (`lib/tracking/boxmot-runner.ts`): cwd-based `uv run python
 * track_runner.py --selftest`, NOT the `--project <abs>` form (that
 * resolves the script relative to the caller's cwd, not the project dir,
 * and fails when invoked from the repo root).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  uvPath,
  sidecarProjectDir,
  trackingModelsDir,
} from "@/lib/tracking/engine-deps";
import { buildUvEnv, trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { uvNetworkFailureMessage } from "@/lib/uv-env/network-failure";

const pexec = promisify(execFile);

/** `pexec`, with uv's offline failure turned into one plain sentence (the raw
 *  text is logged by uvNetworkFailureMessage). This is what
 *  `libi.verify_install` relays when the first self-test after the
 *  managed-Python switch cannot download libi's Python. */
async function selftestExec(
  ...args: Parameters<typeof pexec>
): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await pexec(...args);
    return { stdout: String(r.stdout), stderr: String(r.stderr) };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const offline = uvNetworkFailureMessage("object tracking", stderr);
    if (offline) throw new Error(offline, { cause: err });
    throw err;
  }
}

export interface EngineSelftestResult {
  ok: boolean;
  versions: Record<string, string>;
}

export async function runEngineSelftest(): Promise<EngineSelftestResult> {
  const proj = sidecarProjectDir();
  const { stdout } = await selftestExec(
    uvPath(),
    // `--frozen`: never rewrite the shipped uv.lock (read-only in the packaged app).
    ["run", "--frozen", "python", "track_runner.py", "--selftest"],
    {
      cwd: proj,
      // See boxmot-runner.ts: UV_PROJECT_ENVIRONMENT keeps the venv out of the
      // package tree; `proj` is read-only from uv's point of view.
      env: buildUvEnv({
        UV_PROJECT_ENVIRONMENT: trackingVenvDir(),
        LIBI_TRACK_MODELS:
          process.env.LIBI_TRACK_MODELS ?? trackingModelsDir(),
      }),
      timeout: 170_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  // track_runner.py emits a single JSON line for --selftest, but `uv run`
  // may interleave its own resolve/sync chatter on stdout the first time.
  // Take the last non-empty line and parse that.
  const last =
    stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "{}";
  let parsed: { ok?: boolean; versions?: Record<string, string> };
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = {};
  }
  return { ok: parsed.ok === true, versions: parsed.versions ?? {} };
}
