import { z } from "zod/v3";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { proxyLogger as logger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { buildFilmstripArgs } from "@/lib/filmstrip/args";
import { evictFilmstripsIfOverBudget } from "@/lib/filmstrip/lru";
import { navigationEmitter } from "@/lib/navigation-events";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

const filmstripGenParamsSchema = z.object({
  fileId: z.string().min(1),
});

export type FilmstripGenParams = z.infer<typeof filmstripGenParamsSchema>;

export interface FilmstripGenResult {
  fileId: string;
  filmstripFilename: string;
  frames: number;
  height: number;
  generatedAt: string;
}

/** Number of frames sampled into the sprite. */
export const FILMSTRIP_FRAMES = 20;
/** Per-frame sprite height in px. Generated tall enough to stay crisp on
 *  retina at the (now-shorter) timeline bar height — the strip is downscaled,
 *  never upscaled, so a generous source height beats a soft, blocky bar. */
export const FILMSTRIP_HEIGHT = 96;

/**
 * Generate a horizontal filmstrip sprite for a video file — the cached
 * artifact painted inside timeline bars / base-scene blocks. Mirrors the
 * `proxy_gen` runner's lifecycle exactly (status column transitions, SSE
 * refresh, LRU evict). Server-internal: no `mcpToolId` — there is no chat
 * surface to route progress to.
 */
export const filmstripGenRunner: JobRunner<FilmstripGenParams, FilmstripGenResult> = {
  kind: "filmstrip_gen",
  maxConcurrent: 2,
  paramsSchema: filmstripGenParamsSchema,
  // ffmpeg has no clean midpoint; restart on retry.
  resumable: false,
  // ffmpeg may run silently for a bit — disable the watchdog.
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<FilmstripGenParams>): Promise<FilmstripGenResult> {
    const db = getDb();
    const [file] = db
      .select()
      .from(files)
      .where(eq(files.id, ctx.params.fileId))
      .limit(1)
      .all();
    if (!file) throw new Error(`file not found: ${ctx.params.fileId}`);
    if (file.type !== "video") throw new Error(`file is not a video: ${file.id}`);

    const sourceDir = file.pieceId
      ? path.join(getLibiStorageDir(), file.pieceId)
      : path.join(getLibiStorageDir(), "_global");
    const sourcePath = path.join(sourceDir, file.filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`source missing: ${sourcePath}`);
    }
    // Decode from the PROXY when it's ready — it's the resolution-aware (≤1080p),
    // 1-keyframe/sec, scrub-friendly editor stand-in, so sampling frames from it
    // is faster and matches what the preview shows. Falls back to the original
    // when no proxy exists yet. (Final EXPORT still reads the original elsewhere.)
    const proxyPath =
      file.proxyStatus === "ready" && file.proxyFilename
        ? path.join(sourceDir, file.proxyFilename)
        : null;
    const inputPath = proxyPath && fs.existsSync(proxyPath) ? proxyPath : sourcePath;

    // Mark generating so polling UI clients see live status. Any throw below
    // flips this to "failed" before re-throwing.
    db.update(files)
      .set({ filmstripStatus: "generating" })
      .where(eq(files.id, file.id))
      .run();

    const baseName = path.basename(file.filename, path.extname(file.filename));
    const filmstripName = `${baseName}-filmstrip.jpg`;
    const filmstripPath = path.join(sourceDir, filmstripName);

    try {
      ctx.reportProgress(0, 1, "sprite");

      // Probe duration so we sample `FILMSTRIP_FRAMES` frames evenly across the
      // whole clip via fps = frames / duration. Fall back to a tiny clip if the
      // probe can't read a positive duration (sample every frame; tile clamps).
      const probed = await probeMedia(inputPath);
      const duration =
        typeof probed.duration === "number" && probed.duration > 0
          ? probed.duration
          : null;
      const fps = duration
        ? `${FILMSTRIP_FRAMES}/${duration}`
        : String(FILMSTRIP_FRAMES);

      const ac = new AbortController();
      const cancelWatch = setInterval(() => {
        if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
      }, 1000);

      try {
        await runFfmpeg(
          buildFilmstripArgs(inputPath, filmstripPath, {
            frames: FILMSTRIP_FRAMES,
            height: FILMSTRIP_HEIGHT,
            fps,
          }),
          {
            op: "filmstrip_gen",
            context: { fileId: file.id, pieceId: file.pieceId },
            signal: ac.signal,
          },
        );
      } finally {
        clearInterval(cancelWatch);
      }

      if (ctx.shouldCancel()) {
        try {
          fs.unlinkSync(filmstripPath);
        } catch (err) {
          logger.warn({ err, filmstripPath }, "filmstrip.cancel.unlink_failed");
        }
        throw new Error("cancelled");
      }

      if (!fs.existsSync(filmstripPath)) {
        throw new Error(`filmstrip output missing: ${filmstripPath}`);
      }

      ctx.reportProgress(1, 1, "sprite");

      const generatedAt = new Date();
      db.update(files)
        .set({
          filmstripFilename: filmstripName,
          filmstripStatus: "ready",
          filmstripGeneratedAt: generatedAt,
          filmstripFrames: FILMSTRIP_FRAMES,
          filmstripHeight: FILMSTRIP_HEIGHT,
        })
        .where(eq(files.id, file.id))
        .run();

      // SSE nudge so connected clients invalidate their files/composition
      // query and the timeline re-picks the now-ready sprite.
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
        logger.warn({ err, fileId: file.id }, "filmstrip.refresh_query.emit_failed");
      }

      // Disk-budget LRU — drop oldest non-in-use sprites until under budget.
      try {
        evictFilmstripsIfOverBudget();
      } catch (err) {
        logger.warn({ err }, "filmstrip.lru.evict_failed");
      }

      return {
        fileId: file.id,
        filmstripFilename: filmstripName,
        frames: FILMSTRIP_FRAMES,
        height: FILMSTRIP_HEIGHT,
        generatedAt: generatedAt.toISOString(),
      };
    } catch (err) {
      try {
        db.update(files)
          .set({ filmstripStatus: "failed" })
          .where(eq(files.id, file.id))
          .run();
      } catch (dbErr) {
        logger.warn(
          { err: dbErr, fileId: file.id },
          "filmstrip.status.mark_failed_db_throw",
        );
      }
      throw err;
    }
  },
};
