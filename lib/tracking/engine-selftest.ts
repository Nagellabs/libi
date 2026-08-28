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

const pexec = promisify(execFile);

export interface EngineSelftestResult {
  ok: boolean;
  versions: Record<string, string>;
}

export async function runEngineSelftest(): Promise<EngineSelftestResult> {
  const proj = sidecarProjectDir();
  const { stdout } = await pexec(
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
