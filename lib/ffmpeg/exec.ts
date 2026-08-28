import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getLibiBinDir } from "@/lib/libi-home";
import { ffmpegLogger } from "@/lib/logger";
import { exeSuffix } from "@/lib/platform";

function resolveBin(name: string): string {
  const exeName = `${name}${exeSuffix()}`;
  const bundled = path.join(getLibiBinDir(), exeName);
  if (fs.existsSync(bundled)) return bundled;
  return name; // PATH fallback
}

export function resolveFfmpegPath(): string {
  return resolveBin("ffmpeg");
}

export function resolveFfprobePath(): string {
  return resolveBin("ffprobe");
}

export interface RunFfmpegOptions {
  /** Required identifier — fixed enum per caller (e.g. "trim_video"). */
  op: string;
  /** Structured metadata to attach to every log line. */
  context?: Record<string, unknown>;
  /** Total duration in seconds for progress parsing. */
  totalDurationSeconds?: number;
  /** Called with 0..1 as ffmpeg reports time= progress. */
  onProgress?: (ratio: number) => void;
  /** AbortSignal — SIGKILLs the child on abort. */
  signal?: AbortSignal;
  /** Working directory. */
  cwd?: string;
}

export interface RunFfmpegResult {
  stdout: string;
  stderr: string;
}

function summarizeArgs(args: string[]): string[] {
  return args.map((a) => {
    if (a.length > 120) return `${a.slice(0, 60)}…${a.slice(-50)}`;
    return a;
  });
}

export function runFfmpeg(
  args: string[],
  opts: RunFfmpegOptions,
): Promise<RunFfmpegResult> {
  const ffmpegPath = resolveFfmpegPath();
  const startAt = Date.now();
  const baseFields = { op: opts.op, ...(opts.context ?? {}) };

  ffmpegLogger.info(
    { ...baseFields, event: "start", binary: ffmpegPath, args: summarizeArgs(args) },
    `ffmpeg.start ${opts.op}`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      cwd: opts.cwd,
      // See lib/agents/process-manager.ts: without this every ffmpeg call
      // flashes a console window in the packaged Windows app.
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (buf: Buffer) => { stdout += buf.toString("utf-8"); });

    child.stderr.on("data", (buf: Buffer) => {
      const chunk = buf.toString("utf-8");
      stderr += chunk;
      if (opts.onProgress && opts.totalDurationSeconds && opts.totalDurationSeconds > 0) {
        const match = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (match) {
          const h = Number(match[1]);
          const m = Number(match[2]);
          const s = Number(match[3]);
          const cur = h * 3600 + m * 60 + s;
          const ratio = Math.max(0, Math.min(1, cur / opts.totalDurationSeconds));
          opts.onProgress(ratio);
        }
      }
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - startAt;
      ffmpegLogger.error(
        { ...baseFields, event: "error", durationMs, err: err.message },
        `ffmpeg.error ${opts.op}`,
      );
      reject(err);
    });

    child.on("close", (code) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startAt;
      if (aborted) {
        ffmpegLogger.warn(
          { ...baseFields, event: "cancel", durationMs },
          `ffmpeg.cancel ${opts.op}`,
        );
        return reject(new Error("ffmpeg aborted"));
      }
      if (code !== 0) {
        ffmpegLogger.error(
          { ...baseFields, event: "error", durationMs, exitCode: code, stderrTail: stderr.slice(-500) },
          `ffmpeg.error ${opts.op}`,
        );
        return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
      ffmpegLogger.info(
        { ...baseFields, event: "done", durationMs, exitCode: 0 },
        `ffmpeg.done ${opts.op}`,
      );
      resolve({ stdout, stderr });
    });
  });
}
