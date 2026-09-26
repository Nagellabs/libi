import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { audioProxyReason } from "@/lib/ffmpeg/audio-preview";
import { runOnceSweep } from "@/lib/proxy/regen-once";

/**
 * One-time startup migration: give an AAC proxy to every audio file the
 * preview can't play itself (lib/ffmpeg/audio-preview.ts: a chained Ogg,
 * FLAC in Ogg, a codec WebCodecs doesn't decode). Audio files never had
 * proxies, so the preview played these as silence (review round 4); new ones
 * get theirs at upload (storeFile). One probe per audio file without a proxy.
 *
 * **Next.js process only** (uses the in-process JobManager).
 */
export const AUDIO_PREVIEW_SWEEP_MARKER = "proxy-sweep-audio-preview-v1";

export async function sweepAudioPreviewProxies(): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn({ tag: "proxy", op: "sweep_audio_preview_db_unavailable", err }, "proxy.sweep_audio_preview.db_unavailable");
    return;
  }
  await runOnceSweep(AUDIO_PREVIEW_SWEEP_MARKER, "sweep_audio_preview", async () => {
    const rows = db
      .select()
      .from(files)
      .where(and(eq(files.type, "audio"), isNull(files.proxyFilename), ne(files.proxyStatus, "generating")))
      .all();
    const need: Array<{ id: string; pieceId: string | null }> = [];
    for (const row of rows) {
      const filePath = path.join(getLibiStorageDir(), row.pieceId ?? "_global", row.filename);
      if (!fs.existsSync(filePath)) continue;
      const reason = await audioProxyReason(filePath, await probeMedia(filePath));
      if (reason) need.push({ id: row.id, pieceId: row.pieceId });
    }
    return need;
  });
}
