import { z } from "zod/v3";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { proxyLogger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { buildProxyArgs } from "@/lib/proxy/args";
import { evictProxiesIfOverBudget } from "@/lib/proxy/lru";
import { navigationEmitter } from "@/lib/navigation-events";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

const proxyGenParamsSchema = z.object({
  fileId: z.string().min(1),
});

export type ProxyGenParams = z.infer<typeof proxyGenParamsSchema>;

export interface ProxyGenResult {
  fileId: string;
  proxyFilename: string;
  generatedAt: string;
}

export const proxyGenRunner: JobRunner<ProxyGenParams, ProxyGenResult> = {
  kind: "proxy_gen",
  maxConcurrent: 2,
  paramsSchema: proxyGenParamsSchema,
  // ffmpeg has no clean midpoint; restart on retry.
  resumable: false,
  // ffmpeg may run silently for minutes — disable the watchdog.
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<ProxyGenParams>): Promise<ProxyGenResult> {
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

    // Chokepoint guard for EVERY enqueue path (storeFile, rename route,
    // regenerate_proxy tool, legacy regen sweep): the H.264 yuv420p proxy has
    // no alpha plane, and alphamerge keeps the original RGB planes intact, so
    // an alpha-stripped cutout proxy silently shows the ORIGINAL video with
    // its background restored. Refuse before touching proxyStatus — the row
    // stays idle and pickVideoUrl keeps serving the original bytes.
    //
    // Scoped to preview-recoverable alpha (VPx — `alphaRecoverableInPreview`):
    // for non-VPx alpha (ProRes 4444, qtrle, PNG-in-MOV) preview generally
    // can't decode the original at all, so the opaque proxy is strictly
    // better than no preview and we generate it. The row stores no codec, so
    // probe the source here; a failed probe falls back to the container
    // signal inside the helper (a VPx cutout is a .webm → still refused).
    if (file.hasAlpha) {
      const probed = await probeMedia(sourcePath);
      if (
        alphaRecoverableInPreview({
          hasAlpha: true,
          videoCodec: probed.videoCodec,
          filename: file.filename,
          contentType: file.contentType,
        })
      ) {
        throw new Error(
          `refusing to generate a proxy for alpha-bearing video ${file.id} — ` +
            `the H.264 yuv420p proxy would silently strip the alpha plane`,
        );
      }
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`source missing: ${sourcePath}`);
    }

    // Mark the row as generating so polling UI clients see live status.
    // Any thrown error below flips this to "failed" before re-throwing.
    db.update(files)
      .set({ proxyStatus: "generating" })
      .where(eq(files.id, file.id))
      .run();

    const baseName = path.basename(file.filename, path.extname(file.filename));
    const proxyName = `${baseName}-proxy.mp4`;
    const proxyPath = path.join(sourceDir, proxyName);

    try {
      // ffmpeg has no per-frame progress hook here, so we emit pseudo-progress
      // by stat-ing the output file every second. Total is the source filesize.
      const sourceStat = fs.statSync(sourcePath);
      ctx.reportProgress(0, sourceStat.size, "bytes");

      // Wire an AbortController into runFfmpeg so SIGKILL fires from the
      // 1s cancel watcher. runFfmpeg's signal handler calls SIGKILL directly;
      // we keep our own SIGTERM-first attempt for graceful shutdown if the
      // child happens to be still spawnable but cooperative.
      const ac = new AbortController();
      const watcher = setInterval(() => {
        try {
          const outStat = fs.existsSync(proxyPath) ? fs.statSync(proxyPath) : null;
          // Proxy is ~5x smaller than source; clamp.
          const fakeDone = outStat
            ? Math.min(outStat.size * 5, sourceStat.size)
            : 0;
          ctx.reportProgress(fakeDone, sourceStat.size, "bytes");
        } catch (err) {
          proxyLogger.warn(
            { err, jobId: ctx.jobId },
            "proxy.watcher.stat_failed",
          );
        }
        if (ctx.shouldCancel() && !ac.signal.aborted) {
          // runFfmpeg's onAbort SIGKILLs the child immediately.
          proxyLogger.info(
            { jobId: ctx.jobId, fileId: file.id },
            "proxy.cancel.abort_ffmpeg",
          );
          ac.abort();
        }
      }, 1000);

      try {
        await runFfmpeg(
          buildProxyArgs(sourcePath, proxyPath, { fps: 30 }),
          {
            op: "proxy_gen",
            context: { fileId: file.id, pieceId: file.pieceId },
            signal: ac.signal,
          },
        );
      } finally {
        clearInterval(watcher);
      }

      if (ctx.shouldCancel()) {
        // Clean up partial output.
        try {
          fs.unlinkSync(proxyPath);
        } catch (err) {
          proxyLogger.warn({ err, proxyPath }, "proxy.cancel.unlink_failed");
        }
        throw new Error("cancelled");
      }

      const finalStat = fs.statSync(proxyPath);
      ctx.reportProgress(finalStat.size, finalStat.size, "bytes");

      // Probe the ACTUAL encoded height from the proxy output (not computed
      // from the source) so "downscaled" disclosure is honest. A failed probe
      // must NOT fail the job — leave proxyHeight null and warn.
      let proxyHeight: number | null = null;
      try {
        const probed = await probeMedia(proxyPath);
        if (typeof probed.height === "number" && probed.height > 0) {
          proxyHeight = probed.height;
        } else {
          proxyLogger.warn(
            { tag: "proxy", op: "probe_height_missing", fileId: file.id, proxyPath },
            "proxy.probe.height_missing",
          );
        }
      } catch (err) {
        proxyLogger.warn(
          { tag: "proxy", op: "probe_height_failed", fileId: file.id, proxyPath, err },
          "proxy.probe.height_failed",
        );
      }

      // Update files row — the URL picker reads from here.
      const generatedAt = new Date();
      db.update(files)
        .set({
          proxyFilename: proxyName,
          proxyStatus: "ready",
          proxyGeneratedAt: generatedAt,
          proxyHeight,
        })
        .where(eq(files.id, file.id))
        .run();

      // SSE: nudge the browser so useFiles() refetches and the preview
      // re-picks the now-ready proxy URL. Mirrors the old ProxyManager.
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
        proxyLogger.warn({ err, fileId: file.id }, "proxy.refresh_query.emit_failed");
      }

      // LRU disk-budget enforcement — drop oldest non-in-use proxies until
      // total footprint is under budget. Silent + cheap when under.
      try {
        evictProxiesIfOverBudget();
      } catch (err) {
        proxyLogger.warn({ err }, "proxy.lru.evict_failed");
      }

      return {
        fileId: file.id,
        proxyFilename: proxyName,
        generatedAt: generatedAt.toISOString(),
      };
    } catch (err) {
      try {
        db.update(files)
          .set({ proxyStatus: "failed" })
          .where(eq(files.id, file.id))
          .run();
      } catch (dbErr) {
        proxyLogger.warn(
          { err: dbErr, fileId: file.id },
          "proxy.status.mark_failed_db_throw",
        );
      }
      throw err;
    }
  },
};
