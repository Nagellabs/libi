import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";

/** Called once at server startup. Any `running` or `cancel-requested` rows
 *  from a prior process are stale — `running` flips to `failed` with a
 *  "process restarted" error; `cancel-requested` finalizes to `cancelled`
 *  since the user's intent was already recorded. */
export async function recoverOrphanedJobs(): Promise<void> {
  const db = getDb();
  const orphans = db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["running", "cancel-requested"]))
    .all();
  if (orphans.length === 0) return;
  for (const row of orphans) {
    if (row.status === "running") {
      db.update(jobs)
        .set({
          status: "failed",
          error: "Server restarted while job was running",
          completedAt: new Date(),
        })
        .where(eq(jobs.id, row.id))
        .run();
      logger.warn({ jobId: row.id, kind: row.kind }, "jobs.recovery.marked_failed");
    } else if (row.status === "cancel-requested") {
      db.update(jobs)
        .set({
          status: "cancelled",
          completedAt: new Date(),
        })
        .where(eq(jobs.id, row.id))
        .run();
      logger.warn({ jobId: row.id, kind: row.kind }, "jobs.recovery.marked_cancelled");
    }
  }
}
