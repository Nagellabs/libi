import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import type { JobRecord } from "@/lib/db/schema/types";

export interface InsertJobInput {
  id: string;
  kind: string;
  /** Mandatory in the repo layer; `JobManager` generates a `srv-<uuid>` value
   *  when the caller doesn't supply one. */
  clientKey: string;
  paramsHash: string;
  paramsJson: string;
  pieceId: string | null;
  fileId: string | null;
}

export async function insertJob(input: InsertJobInput): Promise<void> {
  const db = getDb();
  db.insert(jobs).values({
    id: input.id,
    kind: input.kind,
    clientKey: input.clientKey,
    paramsHash: input.paramsHash,
    paramsJson: input.paramsJson,
    pieceId: input.pieceId,
    fileId: input.fileId,
    status: "queued",
  }).run();
}

export async function getJobById(id: string): Promise<JobRecord | null> {
  const db = getDb();
  const [row] = db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all();
  return row ?? null;
}

export async function findJobByKindAndHash(
  kind: string,
  paramsHash: string,
  opts: { excludeTerminal?: boolean } = {},
): Promise<JobRecord | null> {
  const db = getDb();
  const TERMINAL: Array<JobRecord["status"]> = ["completed", "failed", "cancelled"];
  const baseWhere = and(eq(jobs.kind, kind), eq(jobs.paramsHash, paramsHash));
  const where = opts.excludeTerminal
    ? and(baseWhere, notInArray(jobs.status, TERMINAL))
    : baseWhere;
  const [row] = db.select().from(jobs).where(where).limit(1).all();
  return row ?? null;
}

/** Return the running (or queued or cancel-requested) job for (kind, paramsHash),
 *  if any. Used by T13's dedup logic to detect "attach to existing in-flight". */
export async function findRunningByHash(
  kind: string,
  paramsHash: string,
): Promise<JobRecord | null> {
  const db = getDb();
  const RUNNING: Array<JobRecord["status"]> = ["running", "queued", "cancel-requested"];
  const [row] = db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.kind, kind),
      eq(jobs.paramsHash, paramsHash),
      inArray(jobs.status, RUNNING),
    ))
    .limit(1)
    .all();
  return row ?? null;
}

/** Return the most-recent terminal (completed/failed/cancelled) job for
 *  (kind, paramsHash), if any. Used by T13's dedup to detect "matching
 *  cached prior work". Order is `completedAt DESC` so the freshest result
 *  wins. */
export async function findTerminalByHash(
  kind: string,
  paramsHash: string,
): Promise<JobRecord | null> {
  const db = getDb();
  const TERMINAL: Array<JobRecord["status"]> = ["completed", "failed", "cancelled"];
  const [row] = db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.kind, kind),
      eq(jobs.paramsHash, paramsHash),
      inArray(jobs.status, TERMINAL),
    ))
    .orderBy(desc(jobs.completedAt))
    .limit(1)
    .all();
  return row ?? null;
}

export async function listRunning(): Promise<JobRecord[]> {
  const db = getDb();
  return db.select().from(jobs).where(eq(jobs.status, "running")).all();
}

export async function listQueuedByKind(kind: string): Promise<JobRecord[]> {
  const db = getDb();
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.status, "queued")))
    .orderBy(asc(jobs.createdAt))
    .all();
}

export async function markRunning(id: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  db.update(jobs)
    .set({ status: "running", startedAt: now, lastProgressAt: now })
    .where(eq(jobs.id, id))
    .run();
}

export interface ProgressUpdate {
  done: number;
  total: number;
  unit?: string;
  msPerUnit?: number | null;
}

export async function updateProgress(id: string, p: ProgressUpdate): Promise<void> {
  const db = getDb();
  const patch: Partial<JobRecord> = {
    progressDone: p.done,
    progressTotal: p.total,
    lastProgressAt: new Date(),
  };
  if (p.unit !== undefined) patch.progressUnit = p.unit;
  if (p.msPerUnit !== undefined) patch.msPerUnit = p.msPerUnit;
  db.update(jobs).set(patch).where(eq(jobs.id, id)).run();
}

export async function updatePartialPath(id: string, path: string): Promise<void> {
  const db = getDb();
  db.update(jobs).set({ partialPath: path }).where(eq(jobs.id, id)).run();
}

export async function markCompleted(id: string, resultJson: string): Promise<void> {
  const db = getDb();
  db.update(jobs)
    .set({ status: "completed", resultJson, completedAt: new Date(), error: null })
    .where(eq(jobs.id, id))
    .run();
}

export async function markFailed(id: string, error: string): Promise<void> {
  const db = getDb();
  db.update(jobs)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(jobs.id, id))
    .run();
}

export async function markCancelRequested(id: string): Promise<void> {
  const db = getDb();
  db.update(jobs).set({ status: "cancel-requested" }).where(eq(jobs.id, id)).run();
}

export async function markCancelled(id: string): Promise<void> {
  const db = getDb();
  db.update(jobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(jobs.id, id))
    .run();
}
