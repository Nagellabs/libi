import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { JobNotFoundError } from "@/lib/jobs/types";

/** Re-enqueue a failed/cancelled job with the same params. Returns the new
 *  jobId (since enqueue with `resume: false` creates a fresh row). */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const db = getDb();
  const [row] = db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all();
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "failed" && row.status !== "cancelled") {
    return NextResponse.json(
      { error: `cannot retry job in status ${row.status}` },
      { status: 409 },
    );
  }

  let params: unknown;
  try {
    params = JSON.parse(row.paramsJson);
  } catch {
    return NextResponse.json({ error: "invalid params on row" }, { status: 500 });
  }

  const mgr = getJobManager();
  try {
    const result = await mgr.enqueue(row.kind, params, {
      forceNew: true,
      pieceId: row.pieceId,
      fileId: row.fileId,
    });
    // `forceNew: true` returns `new` — EXCEPT for an `exclusiveResource`
    // runner, where a concurrent forced enqueue of the same params makes the
    // guard attach to the live run instead. Attaching is the correct outcome
    // (the work is already happening); 500-ing on it reported an internal
    // error for a system doing the right thing.
    if (result.status !== "new" && result.status !== "attached_running") {
      return NextResponse.json(
        { error: `unexpected enqueue status: ${result.status}` },
        { status: 500 },
      );
    }
    const jobId = result.jobId;
    // Fire-and-forget runToCompletion so the response returns immediately.
    void mgr.runToCompletion(jobId).catch(() => {
      // Errors persist to the row via JobManager.
    });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}
