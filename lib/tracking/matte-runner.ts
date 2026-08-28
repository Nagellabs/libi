import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { uvPath, sidecarProjectDir, trackingModelsDir } from "@/lib/tracking/engine-deps";
import { buildUvEnv, trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { serverLogger as logger } from "@/lib/logger";

export interface MatteSegmentOpts {
  videoPath: string;
  range: { start: number; end: number };
  /** Directory the sidecar writes `f%06d.png` alpha frames into. */
  outputDir: string;
  /** [x, y, w, h] frame-pixel seed box (from libi.ground_target); null/omitted = auto (largest person). */
  seedBox?: [number, number, number, number] | null;
  /** Grayscale seed-mask PNG path (>127 = subject) — overrides derivation. */
  seedMaskPath?: string | null;
  /** Max inference dimension; alpha is upscaled back to source dims. */
  maxDim?: number;
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export interface MatteSegmentResult {
  outputDir: string;
  frameCount: number;
  /** Source fps as measured by the sidecar (drives the compose framerate). */
  framerate: number;
  device: string;
  msPerFrame: number;
  /** Mean fraction of each frame the matte kept (0..1). */
  coverage: number;
  /**
   * Blocking honesty flags from the sidecar's coverage gate:
   * `empty_matte` (subject lost — the spike's 181 all-zero PNGs) or
   * `full_frame_matte` (nothing removed). A healthy `frameCount` alongside a
   * flag is exactly the silent failure a count cannot catch.
   */
  flags: string[];
  /** "no_seed_instance" when the seed step found no subject (frameCount 0). */
  error?: string;
}

/** Pure stdin-payload builder — the ONE place the matte job shape lives on
 *  the Node side. Must match libitrack/matte.py's documented job contract. */
export function matteJobPayload(opts: MatteSegmentOpts): Record<string, unknown> {
  return {
    method: "matte",
    videoPath: resolve(opts.videoPath),
    range: opts.range,
    outputDir: resolve(opts.outputDir),
    seedBox: opts.seedBox ?? null,
    seedMaskPath: opts.seedMaskPath ?? null,
    maxDim: opts.maxDim ?? 1080,
    warmup: 10,
  };
}

export async function runMatteSegment(
  opts: MatteSegmentOpts,
): Promise<MatteSegmentResult> {
  const proj = sidecarProjectDir();

  // cwd-based invocation — `--project <abs>` resolves the script relative to
  // the caller's cwd and fails from the repo root (verified failure mode).
  // `--frozen`: never rewrite the shipped uv.lock (read-only in the packaged app).
  const child = spawn(uvPath(), ["run", "--frozen", "python", "track_runner.py"], {
    cwd: proj,
    // See boxmot-runner.ts: UV_PROJECT_ENVIRONMENT keeps the venv out of the
    // package tree; `proj` is read-only from uv's point of view.
    env: buildUvEnv({
      UV_PROJECT_ENVIRONMENT: trackingVenvDir(),
      LIBI_TRACK_MODELS: process.env.LIBI_TRACK_MODELS ?? trackingModelsDir(),
    }),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.write(JSON.stringify(matteJobPayload(opts)));
  child.stdin.end();

  let buf = "";
  let result: MatteSegmentResult | null = null;

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
          outputDir: String(msg.outputDir ?? ""),
          frameCount: Number(msg.frameCount ?? 0),
          framerate: Number(msg.framerate ?? 0),
          device: String(msg.device ?? "cpu"),
          msPerFrame: Number(msg.msPerFrame ?? 0),
          coverage: Number(msg.coverage ?? 0),
          flags: Array.isArray(msg.flags) ? msg.flags.map(String) : [],
          ...(typeof msg.error === "string" ? { error: msg.error } : {}),
        };
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });

  await new Promise<void>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearInterval(cancelTimer);
      if (code !== 0 && !result) {
        logger.error(
          {
            tag: "matte",
            op: "sidecar.fail",
            code,
            stderr: stderr.slice(-1000),
          },
          "matte sidecar failed",
        );
        return reject(
          new Error(`matte sidecar exited ${code}: ${stderr.slice(-500)}`),
        );
      }
      resolvePromise();
    });
  });

  if (!result) throw new Error("matte sidecar produced no result");
  return result;
}
