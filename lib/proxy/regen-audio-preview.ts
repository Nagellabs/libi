import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { audioProxyVerdict, mayNeedAudioPreviewProxy } from "@/lib/ffmpeg/audio-preview";
import { runOnceSweep } from "@/lib/proxy/regen-once";

/**
 * One-time startup migration: give an AAC proxy to every audio file the
 * preview can't play itself (lib/ffmpeg/audio-preview.ts: a chained Ogg,
 * FLAC in Ogg, a codec WebCodecs doesn't decode, HE-AAC on a mono core).
 * Audio files never had proxies, so the preview played these as silence
 * (review round 4); new ones get theirs at upload (storeFile). One probe per
 * audio file without a proxy whose name the upload would have probed
 * (`mayNeedAudioPreviewProxy`).
 *
 * v2 (AUD-4): the rule gained `he-aac-mono` and now probes .aac, so the sweep
 * runs once more for the files the v1 pass judged fine. A file that already
 * has a proxy is not selected.
 *
 * **Next.js process only** (uses the in-process JobManager).
 */
export const AUDIO_PREVIEW_SWEEP_MARKER = "proxy-sweep-audio-preview-v2";

export async function sweepAudioPreviewProxies(): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn({ tag: "proxy", op: "sweep_audio_preview_db_unavailable", err }, "proxy.sweep_audio_preview.db_unavailable");
    return;
  }
  await runOnceSweep(AUDIO_PREVIEW_SWEEP_MARKER, "sweep_audio_preview", async (done) => {
    const rows = db
      .select()
      .from(files)
      .where(and(eq(files.type, "audio"), isNull(files.proxyFilename), ne(files.proxyStatus, "generating")))
      .all();
    const need: Array<{ id: string; pieceId: string | null }> = [];
    const settled: string[] = [];
    let incomplete = false;
    for (const row of rows) {
      // The upload's own rule: MP3 and FLAC are never probed (review round 5,
      // M4; a .aac is, since AUD-4).
      if (!mayNeedAudioPreviewProxy(row.filename)) continue;
      if (done.has(row.id)) continue; // judged by an earlier, unfinished run
      const filePath = path.join(getLibiStorageDir(), row.pieceId ?? "_global", row.filename);
      if (!fs.existsSync(filePath)) continue;
      const verdict = await audioProxyVerdict(filePath, await probeMedia(filePath));
      if (verdict.reason) need.push({ id: row.id, pieceId: row.pieceId });
      else if (verdict.unknown) incomplete = true; // judged again next boot (review I2)
      else settled.push(row.id);
    }
    return { files: need, settled, incomplete };
  });
}
