import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { getLibiStorageDir } from "@/lib/libi-home";
import { dropProxyFile } from "@/lib/proxy/lifecycle";

/**
 * One-shot startup sweep: backfill `has_alpha` for video rows created before
 * the column existed (migration 0044 left them NULL, and every consumer reads
 * NULL as opaque).
 *
 * For each `type='video' AND has_alpha IS NULL` row whose original bytes are
 * on disk, re-probe via ffprobe and record the truth. A row that probes ALPHA
 * in a preview-recoverable format (VPx — see `alphaRecoverableInPreview`)
 * additionally gets its proxy dropped — any proxy on such a row predates
 * alpha-awareness and is alpha-stripped (i.e. the original video, background
 * and all), so serving or carrying it silently restores the B1 defect.
 * Non-VPx alpha rows (ProRes 4444, qtrle, ...) KEEP their opaque proxy: it is
 * the only thing that previews at all, and exports read the ORIGINAL anyway.
 *
 * Idempotent across boots: backfilled rows are non-NULL and never probed
 * again. Probe failures leave the row NULL (unknown — consumers already treat
 * that as opaque) rather than inventing a value.
 *
 * **Next.js process only** — Category B, non-fatal, fire-and-forget.
 */
export async function sweepBackfillHasAlpha(): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn(
      { tag: "proxy", op: "sweep_backfill_alpha_db_unavailable", err },
      "proxy.sweep_backfill_alpha.db_unavailable",
    );
    return;
  }

  // Pass 0: rows ALREADY known alpha that still carry a proxy — generated
  // before the runner guard landed. pickVideoUrl refuses them, but the
  // alpha-stripped file + `ready` status linger; drop them. Idempotent: after
  // the drop, proxyFilename is NULL and the row never matches again.
  //
  // Scoped to VPx/WebM alpha (`alphaRecoverableInPreview`): only there is the
  // proxy worse-than-nothing (it IS the original with its background back).
  // A non-VPx alpha row (ProRes 4444, qtrle, PNG-in-MOV) KEEPS its opaque
  // proxy — preview generally can't decode its original at all, and exports
  // read the ORIGINAL regardless. No probe here (these rows were flagged by a
  // successful store-time probe): the container signal is decisive for the
  // VPx family, and it keeps this pass cheap and hang-free.
  const staleAlphaProxies = db
    .select()
    .from(files)
    .where(and(eq(files.hasAlpha, true), isNotNull(files.proxyFilename)))
    .all();
  for (const row of staleAlphaProxies) {
    if (
      !alphaRecoverableInPreview({
        hasAlpha: true,
        filename: row.filename,
        contentType: row.contentType,
      })
    ) {
      continue;
    }
    logger.info(
      { tag: "proxy", op: "sweep_backfill_alpha_stale_proxy", fileId: row.id, pieceId: row.pieceId },
      "proxy.sweep_backfill_alpha.stale_alpha_proxy",
    );
    try {
      dropProxyFile(row.id, "alpha_backfill");
    } catch (err) {
      logger.warn(
        { tag: "proxy", op: "sweep_backfill_alpha_drop_failed", fileId: row.id, err },
        "proxy.sweep_backfill_alpha.drop_failed",
      );
    }
  }

  const rows = db
    .select()
    .from(files)
    .where(and(eq(files.type, "video"), isNull(files.hasAlpha)))
    .all();
  if (rows.length === 0) return;

  let filled = 0;
  let alpha = 0;
  let skipped = 0;
  for (const row of rows) {
    const sourcePath = path.join(
      getLibiStorageDir(),
      row.pieceId ?? "_global",
      row.filename,
    );
    if (!fs.existsSync(sourcePath)) {
      skipped++;
      continue;
    }

    let probedAlpha: boolean | undefined;
    let probedCodec: string | undefined;
    try {
      const probed = await probeMedia(sourcePath);
      probedAlpha = probed.hasAlpha;
      probedCodec = probed.videoCodec;
    } catch {
      probedAlpha = undefined;
    }
    if (probedAlpha === undefined) {
      // Unknown stays unknown — NULL already reads as opaque downstream.
      skipped++;
      continue;
    }

    db.update(files)
      .set({ hasAlpha: probedAlpha })
      .where(eq(files.id, row.id))
      .run();
    filled++;

    // Drop the proxy ONLY when preview can recover the alpha from the
    // original (VPx family) — there the pre-fix proxy is worse-than-nothing.
    // Non-VPx alpha (ProRes 4444, qtrle, ...) keeps its working opaque proxy:
    // preview generally can't decode its original at all, and exports read
    // the ORIGINAL regardless.
    if (
      alphaRecoverableInPreview({
        hasAlpha: probedAlpha,
        videoCodec: probedCodec,
        filename: row.filename,
        contentType: row.contentType,
      })
    ) {
      alpha++;
      logger.info(
        { tag: "proxy", op: "sweep_backfill_alpha_hit", fileId: row.id, pieceId: row.pieceId },
        "proxy.sweep_backfill_alpha.alpha_row",
      );
      try {
        dropProxyFile(row.id, "alpha_backfill");
      } catch (err) {
        logger.warn(
          { tag: "proxy", op: "sweep_backfill_alpha_drop_failed", fileId: row.id, err },
          "proxy.sweep_backfill_alpha.drop_failed",
        );
      }
    }
  }

  logger.info(
    { tag: "proxy", op: "sweep_backfill_alpha_summary", total: rows.length, filled, alpha, skipped },
    "proxy.sweep_backfill_alpha.summary",
  );
}
