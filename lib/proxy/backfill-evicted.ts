import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, jobs } from "@/lib/db/schema/sqlite";
import { getLibiHome, getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { listEvictedProxies, recordEvictedProxy } from "@/lib/proxy/evicted";
import { estimateProxyBytes } from "@/lib/proxy/args";
import { proxyByteBudget } from "@/lib/proxy/lru";
import { ENSURE_MAX_PER_PASS } from "@/lib/proxy/ensure";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * One-time boot backfill of eviction records (review n2). The re-make on open
 * (ensure.ts) re-makes only a proxy the LRU recorded as evicted (evicted.ts);
 * 0.1.16's LRU evicted video proxies without recording anything, so on a home
 * upgraded from it those rows would stay `idle` / "pending" for good.
 *
 * Recorded: a VIDEO row that is idle with no proxy, whose `proxy_gen` job
 * COMPLETED (it had a proxy once) and whose original is on disk. The proxy is
 * gone, so its size is ESTIMATED (review FINAL I1): the source's duration
 * (`media_duration`, else probed) × the proxy's estimated bitrate
 * (`estimateProxyBytes`, args.ts), capped at the original's size. Duration
 * unknown: min(original, budget / ENSURE_MAX_PER_PASS). Never 0, which would
 * let it past the fit check (ensure.ts, review I3). v1 recorded the ORIGINAL's
 * size, so a 5 GB 4K recording (a ~300 MB proxy) never fit the 4 GB budget
 * and stayed pending for good; a record the LRU wrote carries the real proxy
 * size, and a wrong estimate only mis-times the fit check once: the LRU
 * records the real size of anything it evicts after.
 *
 * Not recorded:
 * - the onboarding clips, and anything stored with `skipProxyGeneration`:
 *   no `proxy_gen` job ever ran for them;
 * - a failed job (the proxy was never made; retrying would fail the same way);
 * - VPx alpha, judged by the probed codec (it is never proxied);
 * - audio (0.1.16 never evicted an audio proxy);
 * - a file whose record the LRU already wrote (its real size wins).
 * A proxy a user dropped with `libi.drop_proxies` on 0.1.16 reads the same as
 * an evicted one, and is made again on its piece's next open.
 *
 * Runs once (`PROXY_EVICTED_BACKFILL_MARKER`); every record is written before
 * the marker, so a quit part-way runs it again and re-records the same rows.
 * v2: on a home where v1 ran, a record whose size EQUALS its original's is
 * v1's (the LRU records a proxy's own size) and is re-estimated; re-running
 * lands on the same estimate, so it is idempotent.
 *
 * **Next.js process only** — Category B, non-fatal.
 */
export const PROXY_EVICTED_BACKFILL_MARKER = "proxy-evicted-backfill-v2";

/** The evicted proxy's estimated size (see above): never 0, never over the original. */
async function estimatedProxyBytes(row: FileRecord, original: string, originalBytes: number): Promise<number> {
  let duration = row.mediaDuration ?? undefined;
  if (!(typeof duration === "number" && Number.isFinite(duration) && duration > 0)) {
    try {
      duration = (await probeMedia(original)).duration;
    } catch {
      duration = undefined;
    }
  }
  const estimate =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? estimateProxyBytes(duration)
      : Math.floor(proxyByteBudget() / ENSURE_MAX_PER_PASS);
  return Math.max(1, Math.min(originalBytes, estimate));
}

export async function sweepBackfillEvictedProxies(): Promise<{ recorded: number; reestimated: number }> {
  const marker = path.join(getLibiHome(), "state", PROXY_EVICTED_BACKFILL_MARKER);
  if (fs.existsSync(marker)) return { recorded: 0, reestimated: 0 };
  const db = getDb();
  const rows = db
    .select()
    .from(files)
    .where(and(eq(files.type, "video"), eq(files.proxyStatus, "idle"), isNull(files.proxyFilename)))
    .all();
  const already = listEvictedProxies();
  let recorded = 0;
  let reestimated = 0;
  for (const row of rows) {
    const original = path.join(getLibiStorageDir(), row.pieceId ?? "_global", row.filename);
    let originalBytes: number;
    try {
      originalBytes = fs.statSync(original).size;
    } catch {
      continue; // no original: nothing to make a proxy from
    }
    const prior = already[row.id];
    if (prior) {
      // v1's record (sized as the original): re-estimate it. Anything else is
      // the LRU's real size, or this sweep's own estimate: kept.
      if (prior.bytes !== originalBytes) continue;
      const bytes = await estimatedProxyBytes(row, original, originalBytes);
      if (bytes === prior.bytes) continue;
      recordEvictedProxy(row.id, bytes);
      reestimated++;
      continue;
    }
    const [job] = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, "proxy_gen"), eq(jobs.fileId, row.id), eq(jobs.status, "completed")))
      .limit(1)
      .all();
    if (!job) continue;
    if (row.hasAlpha) {
      const probed = await probeMedia(original);
      if (alphaRecoverableInPreview({ hasAlpha: true, videoCodec: probed.videoCodec, filename: row.filename, contentType: row.contentType })) continue;
    }
    recordEvictedProxy(row.id, await estimatedProxyBytes(row, original, originalBytes));
    recorded++;
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()} recorded=${recorded} reestimated=${reestimated}\n`);
  if (recorded > 0 || reestimated > 0) logger.info({ tag: "proxy", op: "evicted_backfill", recorded, reestimated }, "proxy.evicted_backfill");
  return { recorded, reestimated };
}
