import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { enqueueProxyGen } from "@/lib/proxy/enqueue";

/**
 * One-shot startup sweep: regenerate proxies that predate the
 * resolution-aware (1080p) proxy change.
 *
 * **Next.js process only** — uses the in-process `enqueueProxyGen`.
 *
 * Detection signal: a `ready` proxy whose `proxyHeight` is NULL was generated
 * by the old hard-720p pipeline (the column did not exist then). We only
 * re-enqueue when we can tell the existing proxy is genuinely the old kind:
 * `proxyHeight == null` AND the source is taller than 720 (or its height is
 * unknown). Proxies already recorded at a height — i.e. produced by the new
 * pipeline — are never touched, so this is idempotent across boots: once a
 * proxy regenerates it gets a non-null `proxyHeight` and is skipped forever.
 *
 * Conservative by design: a ≤720p source could never have been downgraded by
 * the old 720p cap, so its proxy is already native-resolution — skip it.
 */
export function sweepRegenLegacy720pProxies(): void {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn(
      { tag: "proxy", op: "sweep_regen_720p_db_unavailable", err },
      "proxy.sweep_regen_720p.db_unavailable",
    );
    return;
  }

  const readyRows = db
    .select()
    .from(files)
    .where(eq(files.proxyStatus, "ready"))
    .all();

  let reenqueued = 0;
  for (const row of readyRows) {
    if (!row.proxyFilename) continue;
    // Already on the new pipeline (height recorded) — skip.
    if (row.proxyHeight != null) continue;
    // Old proxy with a known ≤720p source could not have been downgraded —
    // it's already native — so leave it. Unknown source height is treated as
    // potentially-downgraded and regenerated.
    if (typeof row.mediaHeight === "number" && row.mediaHeight <= 720) continue;

    logger.info(
      {
        tag: "proxy",
        op: "sweep_regen_720p",
        fileId: row.id,
        pieceId: row.pieceId,
        mediaHeight: row.mediaHeight ?? null,
      },
      "proxy.sweep_regen_720p",
    );
    enqueueProxyGen(row.id, { pieceId: row.pieceId, regenerate: true });
    reenqueued++;
  }

  if (reenqueued > 0) {
    logger.info(
      { tag: "proxy", op: "sweep_regen_720p_summary", reenqueued },
      "proxy.sweep_regen_720p.summary",
    );
  }
}
