import os from "node:os";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod/v3";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import type { ExportSettings } from "@/lib/engine/types";
import type { RenderPayload } from "@/lib/export/render-jobs";
import {
  createRenderJob,
  rejectRenderJob,
  type RenderJobHandle,
} from "@/lib/export/render-jobs";
import { pickDriver } from "@/lib/export/drivers";
import { muxAudioIntoRender } from "@/lib/export/render-audio-mux";
import {
  planRenderChunks,
  resolveChunkWorkers,
  sumChunkProgress,
} from "@/lib/export/chunk-plan";
import { concatRenderChunks } from "@/lib/export/concat-renders";
import { getCurrentPort } from "@/lib/libi-home";
import { exportLogger } from "@/lib/logger";

/**
 * Runner that drives a Chromium-rendered canvas export. Wraps the existing
 * `render-jobs.ts` registry + driver pair so the chromium-render flow gets
 * the JobManager's lifecycle (queue, dedupe, cancel, status) without
 * re-architecting the token-auth + render-page postback path.
 *
 * When the payload carries `totalFrames` and the composition is long enough,
 * the runner splits the frame range into N chunks (`planRenderChunks`), renders
 * one registry job + one driver page per chunk CONCURRENTLY, ffmpeg-concats the
 * per-chunk video-only files in order, then runs the existing audio mux.
 * JobManager `maxConcurrent` stays 1 (one user export at a time); parallelism is
 * internal to the job. Absent `totalFrames` (old persisted jobs) or a
 * single-chunk plan → the historical single-page path, byte-for-byte unchanged.
 *
 * Limitations (MVP):
 *  - Cancellation is a hard kill: when JobManager flips the AbortSignal we
 *    reject every render-job entry, which causes each `handle.done` to reject
 *    and each Chromium page is torn down by the driver's settlement wait.
 */

// ExportSettings is a structured runtime type; we re-validate the bits we need
// here without duplicating the whole shape. The driver + render page enforce
// the rest.
const exportSettingsSchema = z
  .object({
    format: z.enum(["mp4", "webm"]),
    codec: z.enum(["avc", "vp9", "av1"]),
    bitrate: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  })
  .passthrough();

// RenderPayload comes from the route which already validated/loaded it. We
// accept it as a structurally-typed record here — re-running a deep Zod parse
// would force us to mirror Overlay + AudioClip + FileRecord just
// to re-serialize them. The downstream consumer (the render page) is the
// source of truth for shape validation.
const renderPayloadSchema = z
  .object({
    overlays: z.array(z.unknown()),
    audioClips: z.array(z.unknown()),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    files: z.array(z.unknown()),
  })
  .passthrough();

const exportRenderParamsSchema = z.object({
  pieceId: z.string().min(1),
  payload: renderPayloadSchema,
  settings: exportSettingsSchema,
});

export type ExportRenderParams = {
  pieceId: string;
  payload: RenderPayload;
  settings: ExportSettings;
};

export interface ExportRenderResult {
  /** Absolute path to the rendered file on disk written by the render page. */
  tempFilePath: string;
  durationSeconds: number;
}

export const exportRenderRunner: JobRunner<ExportRenderParams, ExportRenderResult> = {
  kind: "export_render",
  // One export at a time — Chromium pages are heavy and the canvas-source
  // pipeline assumes a single hidden window per host. Chunk parallelism is
  // INTERNAL to a single export_render job (multiple pages on the one browser).
  maxConcurrent: 1,
  paramsSchema: exportRenderParamsSchema as unknown as z.ZodSchema<ExportRenderParams>,
  resumable: false,
  // Renders can run for minutes while encoding; keep the JobManager no-progress
  // watchdog disabled to avoid double-killing. Stall detection now lives in the
  // render-job registry (`RENDER_STALL_TIMEOUT_MS`, reset by the render page's
  // per-frame progress POSTs, PER CHUNK), with `RENDER_ABSOLUTE_CAP_MS` as the
  // runaway backstop. The registry is the single owner of the render timeout.
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<ExportRenderParams>): Promise<ExportRenderResult> {
    const port = getCurrentPort();
    if (!port) throw new Error("Server port not available");

    const totalFrames = ctx.params.payload.totalFrames;

    // Probe the driver's render mode BEFORE planning chunks. Chunking only pays
    // off in software mode (one renderer process per page → real multi-core
    // win); in GPU mode the pages time-slice one GPU/encoder (~1.04×). A
    // mode-probe failure must NEVER fail the export — degrade to single-page.
    const driver = pickDriver();
    let mode: "gpu" | "software" | undefined;
    try {
      mode = await driver.renderMode?.();
    } catch (err) {
      exportLogger.warn(
        {
          event: "render_mode_probe_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "export.render_mode_probe_failed",
      );
      mode = undefined;
    }

    const workers = resolveChunkWorkers(
      process.env.LIBI_RENDER_CHUNK_WORKERS,
      mode,
      os.cpus().length,
    );
    const chunks =
      totalFrames && totalFrames > 0
        ? planRenderChunks(totalFrames, workers)
        : [];

    exportLogger.info(
      { event: "render_chunk_plan", mode: mode ?? "gpu", workers, chunks: chunks.length },
      "export.render_chunk_plan",
    );

    if (!totalFrames || chunks.length <= 1) {
      return runSingle(ctx, port);
    }
    return runChunked(ctx, port, totalFrames, chunks);
  },
};

/**
 * Historical single-page path — unchanged behavior. Used when the payload has
 * no `totalFrames` (old persisted jobs) or the plan is a single chunk
 * (short comp, or `LIBI_RENDER_CHUNK_WORKERS=1`).
 */
async function runSingle(
  ctx: JobContext<ExportRenderParams>,
  port: number,
): Promise<ExportRenderResult> {
  const handle = createRenderJob({
    pieceId: ctx.params.pieceId,
    payload: ctx.params.payload,
    settings: ctx.params.settings,
    onProgress: (done, total) => {
      ctx.reportProgress(done, total, "frames");
    },
  });

  const driver = pickDriver();
  exportLogger.info(
    {
      event: "render_submit",
      jobId: handle.jobId,
      runnerJobId: ctx.jobId,
      driver: driver.name,
      mode: "single",
    },
    "export.render_submit",
  );

  // Initial progress stamp — gives the JobManager / clients a baseline.
  ctx.reportProgress(0, 1, "render");

  // If JobManager flips cancel mid-render, reject the registry entry so
  // `handle.done` rejects and the driver's hard-cap tears the page down.
  let cancelPoll: NodeJS.Timeout | null = setInterval(() => {
    if (ctx.shouldCancel()) {
      rejectRenderJob(handle.jobId, handle.token, "cancelled by job manager");
      if (cancelPoll) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
    }
  }, 500);

  // Drive the Chromium page. The driver returns when the page closes (or
  // the render-job registry settles it); the registry entry resolves via the
  // render page's postback to /api/export/render-result. We await both: if the
  // driver throws before the render page POSTed back, reject the registry entry
  // so `handle.done` doesn't hang waiting on the registry's stall watchdog /
  // absolute cap.
  const runPromise = driver.runJob({ jobId: handle.jobId, port });
  runPromise.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    exportLogger.warn(
      {
        event: "driver_failure",
        jobId: handle.jobId,
        driver: driver.name,
        error: message,
      },
      "export.driver_failure",
    );
    rejectRenderJob(
      handle.jobId,
      handle.token,
      `Driver ${driver.name} failed: ${message}`,
    );
  });

  try {
    const { tempFilePath, durationSeconds } = await handle.done;
    // The render page emits a VIDEO-ONLY file (the canvas-source encoder has
    // no audio API). Mux the composition's audio onto it in a fast
    // stream-copy pass so multi-scene exports carry sound. No-ops (returns
    // tempFilePath unchanged) when there are no enabled audio clips.
    const finalPath = await muxAudioIntoRender({
      videoPath: tempFilePath,
      audioClips: ctx.params.payload.audioClips,
      files: ctx.params.payload.files,
      format: ctx.params.settings.format,
      audioBitrate: ctx.params.settings.audioBitrate,
      durationSeconds,
    });
    ctx.reportProgress(1, 1, "render");
    return { tempFilePath: finalPath, durationSeconds };
  } finally {
    if (cancelPoll) {
      clearInterval(cancelPoll);
      cancelPoll = null;
    }
  }
}

/**
 * Chunked parallel path — one registry job + one driver page per chunk,
 * concurrently, concat in chunk order, then the same audio mux.
 */
async function runChunked(
  ctx: JobContext<ExportRenderParams>,
  port: number,
  totalFrames: number,
  chunks: Array<{ startFrame: number; endFrameExclusive: number }>,
): Promise<ExportRenderResult> {
  const driver = pickDriver();
  const fps = ctx.params.settings.fps;
  const doneByChunk = new Array<number>(chunks.length).fill(0);

  // Aggregate progress baseline.
  ctx.reportProgress(0, totalFrames, "frames");

  // One registry entry per chunk. Progress from every chunk rolls up into the
  // single aggregate frame count so the client bar advances smoothly.
  const handles: RenderJobHandle[] = chunks.map((chunk, i) =>
    createRenderJob({
      pieceId: ctx.params.pieceId,
      payload: { ...ctx.params.payload, frameRange: chunk },
      settings: ctx.params.settings,
      onProgress: (done) => {
        doneByChunk[i] = done;
        ctx.reportProgress(sumChunkProgress(doneByChunk), totalFrames, "frames");
      },
    }),
  );

  exportLogger.info(
    {
      event: "render_submit",
      runnerJobId: ctx.jobId,
      driver: driver.name,
      mode: "chunked",
      chunks: chunks.length,
      jobIds: handles.map((h) => h.jobId),
      totalFrames,
    },
    "export.render_submit",
  );

  // Cancel poll — on JobManager cancel, reject ALL chunk entries so every
  // `handle.done` rejects and every driver page tears down.
  let cancelPoll: NodeJS.Timeout | null = setInterval(() => {
    if (ctx.shouldCancel()) {
      for (const h of handles) {
        rejectRenderJob(h.jobId, h.token, "cancelled by job manager");
      }
      if (cancelPoll) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
    }
  }, 500);

  // Launch a driver page per chunk concurrently. The playwright driver's
  // getBrowser() is single-flight, so all pages share one browser. A driver
  // failure rejects only that chunk's registry entry (the fail-fast guard below
  // then rejects the siblings).
  for (const h of handles) {
    const runPromise = driver.runJob({ jobId: h.jobId, port });
    runPromise.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      exportLogger.warn(
        {
          event: "driver_failure",
          jobId: h.jobId,
          driver: driver.name,
          error: message,
        },
        "export.driver_failure",
      );
      rejectRenderJob(
        h.jobId,
        h.token,
        `Driver ${driver.name} failed: ${message}`,
      );
    });
  }

  // Track completed-chunk temp dirs for cleanup even if a sibling later fails.
  const chunkDirs = new Set<string>();
  let firstError: Error | null = null;

  // Fail-fast: on the FIRST chunk rejection, reject every still-pending sibling
  // ("sibling chunk failed") so the whole export aborts promptly and pages tear
  // down. But then WAIT for every chunk promise to SETTLE before throwing — a
  // sibling that resolves in the race window still records its temp dir into
  // `chunkDirs` (its resolve branch below), so the finally sweep can drop it
  // instead of leaking it. The ORIGINAL first error (not "sibling chunk
  // failed") is what we throw.
  const guarded = handles.map((h) =>
    h.done.then(
      (res) => {
        chunkDirs.add(dirname(res.tempFilePath));
        return res;
      },
      (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!firstError) {
          firstError = e;
          for (const other of handles) {
            rejectRenderJob(other.jobId, other.token, "sibling chunk failed");
          }
        }
        throw e;
      },
    ),
  );

  try {
    // allSettled never short-circuits, so every chunk (including any that
    // resolves AFTER the first failure) has finished and recorded its temp dir
    // before we proceed — no dir escapes the finally sweep.
    const settled = await Promise.allSettled(guarded);
    if (firstError) throw firstError;

    // All fulfilled here (no firstError). `settled` preserves `guarded` order,
    // i.e. chunk order by startFrame — so the concat below stays ordered.
    const results = settled.map((s) => {
      if (s.status === "fulfilled") return s.value;
      // Defensive: a rejection with no firstError set shouldn't happen, but
      // surface it honestly rather than silently dropping a chunk.
      throw s.reason instanceof Error ? s.reason : new Error(String(s.reason));
    });

    // Concat the per-chunk video-only files in chunk order (lossless -c copy).
    const chunkPaths = results.map((r) => r.tempFilePath);
    const concatPath = await concatRenderChunks(
      chunkPaths,
      ctx.params.settings.format,
    );

    const durationSeconds = totalFrames / fps;
    // Mux the composition's audio onto the concatenated video, exactly as the
    // single path does. No-ops when there are no enabled audio clips.
    const finalPath = await muxAudioIntoRender({
      videoPath: concatPath,
      audioClips: ctx.params.payload.audioClips,
      files: ctx.params.payload.files,
      format: ctx.params.settings.format,
      audioBitrate: ctx.params.settings.audioBitrate,
      durationSeconds,
    });

    ctx.reportProgress(totalFrames, totalFrames, "frames");
    return { tempFilePath: finalPath, durationSeconds };
  } finally {
    if (cancelPoll) {
      clearInterval(cancelPoll);
      cancelPoll = null;
    }
    // Best-effort: remove each completed chunk's temp dir. The final
    // concat/mux output lives in its OWN dir (removed by the backend), so
    // dropping the chunk dirs here avoids /tmp bloat across repeated exports.
    for (const dir of chunkDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
