import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";

/** Called once at server startup. Any `running` or `cancel-requested` row from a prior
 *  process is stale, and so is any `queued` row created BEFORE this process started —
 *  nothing in this process will ever pick it up, and left alone it reads as a download
 *  that is permanently in flight. `running` and `queued` flip to `failed`;
 *  `cancel-requested` finalizes to `cancelled`, the user's intent already recorded.
 *
 *  `processStartedAt` is a parameter rather than a module constant so the cutoff is
 *  testable, and so a caller that boots the manager late cannot orphan its own work. */
export async function recoverOrphanedJobs(
  processStartedAt: number = Date.now(),
): Promise<void> {
  const db = getDb();
  const orphans = db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["running", "cancel-requested", "queued"]))
    .all();
  if (orphans.length === 0) return;
  for (const row of orphans) {
    if (row.status === "queued" && row.createdAt.getTime() >= processStartedAt) continue;
    if (row.status === "running" || row.status === "queued") {
      db.update(jobs)
        .set({
          status: "failed",
          error: "Server restarted while job was running",
          completedAt: new Date(),
        })
        .where(eq(jobs.id, row.id))
        .run();
      logger.warn(
        { jobId: row.id, kind: row.kind, tag: "jobs", op: "jobs.recovery.marked_failed" },
        "jobs.recovery.marked_failed",
      );
    } else if (row.status === "cancel-requested") {
      db.update(jobs)
        .set({
          status: "cancelled",
          completedAt: new Date(),
        })
        .where(eq(jobs.id, row.id))
        .run();
      logger.warn(
        { jobId: row.id, kind: row.kind, tag: "jobs", op: "jobs.recovery.marked_cancelled" },
        "jobs.recovery.marked_cancelled",
      );
    }
  }
}
