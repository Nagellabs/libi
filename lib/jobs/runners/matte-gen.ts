import { z } from "zod/v3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { getLibiStorageDir } from "@/lib/libi-home";
import { buildMatteComposeArgs, cutoutFilename } from "@/lib/matte/args";
import { runMatteSegment } from "@/lib/tracking/matte-runner";
import {
  trackingEngineInstalled,
  trackingNotInstalledError,
} from "@/lib/tracking/not-installed";
import { storeFile } from "@/mcp/tools/file-tools";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { CancelledError } from "@/lib/jobs/types";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

// Deterministic — this exact object is Zod-validated AND hashed for dedupe.
// NO toolCallId / sessionId / timestamps here (they break paramsHash dedupe).
const matteGenParamsSchema = z.object({
  fileId: z.string().min(1),
  // Only the local engine runs through JobManager; the fal path is
  // agent-driven via the fal MCP (see mcp/tools/matte-tools.ts).
  engine: z.literal("local"),
  subject: z.object({
    kind: z.enum(["auto", "box"]),
    // [x, y, w, h] frame pixels (a libi.ground_target candidate bbox).
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }),
  range: z
    .object({ start: z.number().nonnegative(), end: z.number().positive() })
    .optional(),
});

export type MatteGenParams = z.infer<typeof matteGenParamsSchema>;

export interface MatteGenResult {
  cutoutFileId: string;
  frameCount: number;
  framerate: number;
  engine: "local";
  msPerFrame: number;
}

export const matteGenRunner: JobRunner<MatteGenParams, MatteGenResult> = {
  kind: "matte_gen",
  mcpToolId: [
    makeMcpToolId("libi", "libi.remove_background"),
    makeMcpToolId("libi-tracking", "libi.remove_background"),
  ],
  maxConcurrent: 1, // MatAnyone torch inference is CPU/MPS-heavy.
  paramsSchema: matteGenParamsSchema,
  // MatAnyone's memory-propagation state is not serializable across process
  // restarts — a retried job honestly restarts its range (spec's "checkpoint
  // at frame boundaries" is satisfied by progress ticks, not resume state).
  resumable: false,
  // Model load + the ffmpeg compose pass can be silent for minutes.
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<MatteGenParams>): Promise<MatteGenResult> {
    if (!trackingEngineInstalled()) {
      throw new Error(JSON.stringify(trackingNotInstalledError()));
    }

    const db = getDb();
    const [file] = db
      .select()
      .from(files)
      .where(eq(files.id, ctx.params.fileId))
      .limit(1)
      .all();
    if (!file) throw new Error(`file not found: ${ctx.params.fileId}`);
    if (file.type !== "video") {
      throw new Error(
        `file is not a video: ${file.id} (photos go through the fal birefnet path)`,
      );
    }

    // HARD INVARIANT: read the ORIGINAL file, never the proxy.
    const sourceDir = file.pieceId
      ? path.join(getLibiStorageDir(), file.pieceId)
      : path.join(getLibiStorageDir(), "_global");
    const sourcePath = path.join(sourceDir, file.filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`source missing: ${sourcePath}`);
    }

    let duration = file.mediaDuration ?? null;
    if (duration == null) {
      const probed = await probeMedia(sourcePath);
      duration = probed.duration ?? null;
    }
    if (duration == null) {
      throw new Error(`cannot determine duration of ${sourcePath}`);
    }
    const range = ctx.params.range ?? { start: 0, end: duration };

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-matte-"));
    const alphaDir = path.join(workDir, "alpha");
    fs.mkdirSync(alphaDir, { recursive: true });

    try {
      logger.info(
        {
          tag: "matte",
          op: "matte_start",
          jobId: ctx.jobId,
          fileId: file.id,
          range,
          subject: ctx.params.subject.kind,
        },
        "matte generation start",
      );

      const matte = await runMatteSegment({
        videoPath: sourcePath,
        range,
        outputDir: alphaDir,
        seedBox:
          ctx.params.subject.kind === "box"
            ? ctx.params.subject.box ?? null
            : null,
        onProgress: (done, total) => ctx.reportProgress(done, total, "frames"),
        shouldCancel: () => ctx.shouldCancel(),
      });
      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
      if (matte.error || matte.frameCount === 0) {
        throw new Error(
          matte.error === "no_seed_instance"
            ? "no_seed_instance: the seed step found no subject at the range start — " +
              "pass a subject box from libi.ground_target, or use the fal engine"
            : "matte produced no frames",
        );
      }
      // Honesty gate. frameCount is a COUNT — necessary but NOT sufficient:
      // the spike shipped 181 alpha PNGs that were entirely zero and passed
      // every count-based check. Refuse to STORE a matte the sidecar flagged,
      // so a silent no-op can never reach the user as a "successful" cutout.
      if (matte.flags.length > 0) {
        const pct = (matte.coverage * 100).toFixed(2);
        const why =
          matte.flags.includes("empty_matte")
            ? `empty_matte: the matte kept only ${pct}% of the frame — the subject was lost, ` +
              "so the cutout would render as nothing. Re-seed with a subject box from " +
              "libi.ground_target, start the range where the subject is clearly visible, " +
              "or use the paid fal engine."
            : `full_frame_matte: the matte kept ${pct}% of the frame — nothing was removed, ` +
              "so compositing this over a new background would silently show the original " +
              "scene. Re-seed with a tighter subject box, or use the paid fal engine.";
        logger.warn(
          {
            tag: "matte",
            op: "matte_coverage_rejected",
            jobId: ctx.jobId,
            fileId: file.id,
            coverage: matte.coverage,
            flags: matte.flags,
            frameCount: matte.frameCount,
          },
          "matte rejected by coverage gate",
        );
        throw new Error(why);
      }

      const cutoutName = cutoutFilename(file.filename);
      const cutoutPath = path.join(workDir, cutoutName);
      const ac = new AbortController();
      const cancelWatcher = setInterval(() => {
        if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
      }, 1000);
      try {
        await runFfmpeg(
          buildMatteComposeArgs(sourcePath, alphaDir, cutoutPath, {
            range,
            framerate: matte.framerate,
            frameCount: matte.frameCount,
          }),
          {
            op: "matte_compose",
            context: { fileId: file.id, pieceId: file.pieceId, jobId: ctx.jobId },
            signal: ac.signal,
          },
        );
      } finally {
        clearInterval(cancelWatcher);
      }
      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);

      const record = await storeFile({
        pieceId: file.pieceId,
        filename: cutoutName,
        buffer: fs.readFileSync(cutoutPath),
        contentType: "video/webm",
        // We KNOW the compose pass wrote yuva420p — assert it rather than
        // relying on storeFile's probe (a probe failure would leave
        // hasAlpha=false and enqueue an alpha-stripping proxy).
        hasAlpha: true,
        name: cutoutName,
        description:
          `Alpha cutout of "${file.name}" (${range.start.toFixed(2)}-` +
          `${range.end.toFixed(2)}s, MatAnyone local matte, VP9-alpha WebM)`,
      });

      // Nudge connected UIs so the new asset appears without a manual refresh.
      try {
        if (file.pieceId) {
          navigationEmitter.emit("refresh_query", {
            queryKey: "piece",
            pieceId: file.pieceId,
          });
        } else {
          navigationEmitter.emit("refresh_query", { queryKey: "files" });
        }
      } catch (err) {
        logger.warn(
          { tag: "matte", op: "refresh_query_emit_failed", err, fileId: file.id },
          "matte refresh_query emit failed",
        );
      }

      logger.info(
        {
          tag: "matte",
          op: "matte_done",
          jobId: ctx.jobId,
          fileId: file.id,
          cutoutFileId: record.id,
          frameCount: matte.frameCount,
          device: matte.device,
          msPerFrame: matte.msPerFrame,
        },
        "matte generation complete",
      );

      return {
        cutoutFileId: record.id,
        frameCount: matte.frameCount,
        framerate: matte.framerate,
        engine: "local",
        msPerFrame: matte.msPerFrame,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  },
};
