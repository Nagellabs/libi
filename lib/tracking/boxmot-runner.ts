import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { uvPath, sidecarProjectDir, trackingModelsDir } from "@/lib/tracking/engine-deps";
import { buildUvEnv, trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { serverLogger as logger } from "@/lib/logger";
import type { TrackSample } from "@/lib/tracking/types";

export interface EngineSegmentOpts {
  videoPath: string;
  fps: number;
  range: { start: number; end: number };
  method: string;
  classes: string[];
  anchors: { time: number; bbox: [number, number, number, number] }[];
  /** When true the sidecar keeps the robust person track for identity
   *  but emits the HEAD sub-region derived from the person's
   *  segmentation silhouette (set by the runner when objectKind:"face"). */
  headRefine?: boolean;
  exemplarPath?: string | null;
  onProgress?: (done: number, total: number) => void;
  onCheckpoint?: (state: unknown) => Promise<void>;
  shouldCancel?: () => boolean;
}

export interface EngineSegmentResult {
  samples: TrackSample[];
  framerate: number;
  /**
   * Only set when the sidecar ran in shot-detection mode (`method: "shots"`).
   * Carries the clip's detected shot ranges; `samples` is `[]` for such runs.
   */
  shots?: { start: number; end: number }[];
  /**
   * Only set when the sidecar ran in Stage-0 grounding mode (`method: "ground"`).
   * Carries NUMBERED candidate boxes at the requested frame; `samples` is `[]`.
   */
  candidates?: { index: number; bbox: number[]; label: string; conf: number }[];
  /**
   * Only set when the sidecar ran in identity-candidates mode
   * (`method: "candidates"`). Carries the competing tracklets ranked
   * best-first by meanTargetSim; `samples` is `[]` for such runs.
   */
  candidateTracklets?: IdentityCandidate[];
}

/** A competing tracklet emitted by the sidecar in `method:"candidates"` mode.
 *  Ranked best-first (highest meanTargetSim first; null sims keep sidecar order). */
export interface IdentityCandidate {
  /** Stable stitched id across the requested window (NOT a raw per-frame BoT-SORT id). */
  candidateId: number;
  /** Per-frame bbox samples for this tracklet. Sparse — only frames where the tracklet was present. */
  perFrame: { t: number; bbox: [number, number, number, number] }[];
  /** Mean cosine similarity to the anchor template over present frames.
   *  `null` when ReID is disabled (motion-only fallback). */
  meanTargetSim: number | null;
  /** Number of frames present (`perFrame.length`). */
  frameCount: number;
}

/** Defensive per-sample coercion of the sidecar's loose JSON onto
 *  TrackSample. Keeps targetSim a strict `number | null`. */
export function normalizeSamples(raw: unknown): TrackSample[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((s) => {
    const o = s as Record<string, unknown>;
    const ts = o.targetSim;
    return {
      ...(o as object),
      targetSim:
        ts === undefined || ts === null ? null : Number(ts),
    } as TrackSample;
  });
}

export async function runEngineSegment(
  opts: EngineSegmentOpts,
): Promise<EngineSegmentResult> {
  const proj = sidecarProjectDir();

  // Use cwd-based invocation: `uv run python track_runner.py` with cwd=proj.
  // The `--project <abs>` form resolves the script relative to the caller's
  // cwd, not the project dir, so it fails when invoked from the repo root.
  const child = spawn(
    uvPath(),
    // `--frozen`: run from the shipped uv.lock and never rewrite it. The lock
    // lives in the package, which is read-only in the packaged app.
    ["run", "--frozen", "python", "track_runner.py"],
    {
      cwd: proj,
      // buildUvEnv pins UV_PROJECT_ENVIRONMENT to the LIBI_HOME venv — the
      // same one `uv sync` created — so `uv run` never falls back to creating
      // `<proj>/.venv` inside the (read-only, signed) package.
      // LIBI_TRACK_MODELS respects an explicit override (e.g. set by a test
      // harness or the user), else computes from the Libi home.
      env: buildUvEnv({
        UV_PROJECT_ENVIRONMENT: trackingVenvDir(),
        LIBI_TRACK_MODELS: process.env.LIBI_TRACK_MODELS ?? trackingModelsDir(),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Always pass an absolute path so the sidecar can find the file
  // regardless of its own working directory (mcp/tracking/py).
  const absoluteVideoPath = resolve(opts.videoPath);

  child.stdin.write(
    JSON.stringify({
      videoPath: absoluteVideoPath,
      fps: opts.fps,
      range: opts.range,
      method: opts.method,
      classes: opts.classes,
      anchors: opts.anchors,
      headRefine: opts.headRefine ?? false,
      exemplarPath: opts.exemplarPath ?? null,
    }),
  );
  child.stdin.end();

  let buf = "";
  let result: EngineSegmentResult | null = null;

  const cancelTimer = setInterval(() => {
    if (opts.shouldCancel?.()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 1000);

  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "progress") {
        opts.onProgress?.(Number(msg.done), Number(msg.total));
      } else if (msg.type === "result") {
        result = {
          samples: normalizeSamples(msg.samples),
          framerate: Number(msg.framerate),
          ...(Array.isArray(msg.shots)
            ? { shots: msg.shots as { start: number; end: number }[] }
            : {}),
          ...(Array.isArray(msg.candidates)
            ? { candidates: msg.candidates as { index: number; bbox: number[]; label: string; conf: number }[] }
            : {}),
          ...(Array.isArray(msg.candidateTracklets)
            ? { candidateTracklets: msg.candidateTracklets as IdentityCandidate[] }
            : {}),
        };
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearInterval(cancelTimer);
      if (code !== 0 && !result) {
        logger.error(
          {
            tag: "tracking-engine",
            op: "sidecar.fail",
            code,
            stderr: stderr.slice(-1000),
          },
          "engine sidecar failed",
        );
        return reject(
          new Error(
            `tracking sidecar exited ${code}: ${stderr.slice(-500)}`,
          ),
        );
      }
      resolve();
    });
  });

  if (!result) throw new Error("tracking sidecar produced no result");
  return result;
}
