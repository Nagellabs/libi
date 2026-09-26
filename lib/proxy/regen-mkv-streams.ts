import path from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { readMatroskaTrackFlags } from "@/lib/ffmpeg/matroska-tracks";
import { runOnceSweep } from "@/lib/proxy/regen-once";

/**
 * One-time startup migration: regenerate the proxies of Matroska/WebM files
 * whose primary stream the server now chooses differently.
 *
 * Since 1cb10147 the server passes over the Matroska tracks mediabunny drops
 * (FlagEnabled = 0, or a ContentEncoding other than header stripping), so the
 * proxy maps the stream the preview plays. A proxy made before carries the
 * old choice: on a file whose first default audio track is disabled, the
 * proxy has that track while the preview and the export play the next one
 * (review round 2, M5).
 *
 * Which files: a `ready` proxy of a Matroska original with such a track, of a
 * type (audio or video) that has more than one track; with a single track of
 * the type the choice can't have changed. The check reads 1 MiB of each MKV
 * and runs no ffprobe. The regeneration goes through the normal `proxy_gen`
 * job path, and the marker under LIBI_HOME is written once every one has
 * finished (regen-once.ts): every proxy made after it is made by the new rule.
 *
 * **Next.js process only** (uses the in-process JobManager).
 */
export const MKV_STREAMS_SWEEP_MARKER = "proxy-sweep-mkv-streams-v1";

const MATROSKA = /\.(mkv|webm|mka|mk3d)$/i;

export async function sweepRegenMkvStreamProxies(): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn({ tag: "proxy", op: "sweep_regen_mkv_streams_db_unavailable", err }, "proxy.sweep_regen_mkv_streams.db_unavailable");
    return;
  }
  // Waits for every regeneration before writing the marker, one writer per
  // file (regen-once.ts).
  await runOnceSweep(MKV_STREAMS_SWEEP_MARKER, "sweep_regen_mkv_streams", async () => {
    const rows = db
      .select()
      .from(files)
      .where(and(eq(files.proxyStatus, "ready"), isNotNull(files.proxyFilename)))
      .all()
      .filter((r) => MATROSKA.test(r.filename) || /matroska|webm/i.test(r.contentType ?? ""));
    const affected: Array<{ id: string; pieceId: string | null }> = [];
    for (const row of rows) {
      const source = path.join(getLibiStorageDir(), row.pieceId ?? "_global", row.filename);
      const flags = await readMatroskaTrackFlags(source);
      if (!flags) continue;
      const changed = [1, 2].some((type) => {
        const ofType = flags.filter((f) => f.type === type);
        return ofType.length > 1 && ofType.some((f) => !f.listedByPreview);
      });
      if (changed) affected.push({ id: row.id, pieceId: row.pieceId });
    }
    return affected;
  });
}
