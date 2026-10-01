/**
 * The piece_exports store — the source of truth for "what exports exist"
 * (spec 2026-09-29 §A1). Server only. Every WRITE logs `tag: "export"`,
 * `op: "record_*"` and emits `refresh_query { queryKey: "exports" }` over the
 * one SSE connection, so the Exports tab and the resources panel refetch.
 *
 * Decision: a name is unique per piece among rows that are NOT cancelled
 * (`uniqueExportName` below) — a cancelled row's name frees up for reuse,
 * since cancelled rows are hidden from every list.
 *
 * `listExportViews` / `getExportView` are READ-ONLY (controller amendment
 * #4): they DERIVE a reconciled status for the view they return, but never
 * persist it and never emit SSE from a read — a GET route must not write.
 * Only the runner, `lib/exports/actions.ts#removeExport` and
 * `recoverOrphanedExports` (boot recovery) actually write a reconciled
 * status.
 *
 * No `lib/jobs/manager` import here (the export runner imports this module);
 * cancel-and-remove lives in lib/exports/actions.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs, pieceExports, pieces } from "@/lib/db/schema/sqlite";
import type { JobRecord, PieceExportRow } from "@/lib/db/schema/types";
import type { AudioDecision } from "@/lib/export/audio-policy";
import type { DroppedOverlay } from "@/lib/export/dropped-overlays";
import { EXPORT_WAITING_MESSAGE, EXPORT_WAITING_UNIT } from "@/lib/export/export-waiting";
import { sanitizeFilename } from "@/lib/export/filename";
import { getExportScheduler } from "@/lib/export/scheduler";
import { snapshotFromRow } from "@/lib/jobs/types";
import { exportLogger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { aspectOf } from "./aspect";
import { absoluteExportPath, exportsDirFor, fileStem } from "./paths";
import type { ExportRecordStatus, ExportRecordView, ExportStartedBy, ExportWaiting } from "./types";

export const LOST_EXPORT_MESSAGE = "libi lost track of this export. Export it again.";
export const RESTARTED_EXPORT_MESSAGE = "libi quit while this export was running. Export it again.";

/** A queued row with no job yet is given this long before it counts as lost. */
const UNCLAIMED_GRACE_MS = 60_000;

export function newExportId(): string {
  return `exp_${randomUUID().replace(/-/g, "")}`;
}

/** Tell every open page that this piece's exports changed. */
export function emitExportsChanged(pieceId: string, exportId: string, status: ExportRecordStatus | "deleted" | "renamed"): void {
  navigationEmitter.emit("refresh_query", { queryKey: "exports", pieceId, exportId, status });
}

/** The stem a requested name is written as: the same rules `claimExportPath` applies. */
export function exportStem(desired: string, ext: string): string {
  const e = ext.replace(/^\./, "").toLowerCase();
  const trimmed = desired.trim();
  const stem = trimmed.toLowerCase().endsWith(`.${e}`) ? trimmed.slice(0, -(e.length + 1)) : trimmed;
  return sanitizeFilename(stem);
}

/**
 * A name no other export of this piece uses — compared case-insensitively
 * against rows that are not cancelled and against files already in the
 * piece's exports folder. Collision → `-1`, `-2`, …
 */
export async function uniqueExportName(
  pieceId: string,
  desired: string,
  ext: string,
  opts: { exceptId?: string } = {},
): Promise<string> {
  const stem = exportStem(desired, ext);
  const taken = new Set<string>();
  let ownName: string | null = null;
  for (const r of getDb()
    .select({ id: pieceExports.id, name: pieceExports.name, status: pieceExports.status })
    .from(pieceExports)
    .where(eq(pieceExports.pieceId, pieceId))
    .all()) {
    if (r.id === opts.exceptId) {
      ownName = r.name.toLowerCase();
      continue;
    }
    if (r.status !== "cancelled") taken.add(r.name.toLowerCase());
  }
  try {
    for (const f of fs.readdirSync(await exportsDirFor(pieceId))) {
      const s = fileStem(f).toLowerCase();
      if (s !== ownName) taken.add(s);
    }
  } catch {
    // No exports folder yet.
  }
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export interface CreateExportInput {
  id?: string;
  pieceId: string;
  name: string;
  jobId?: string | null;
  source: ExportStartedBy;
  settings: {
    format: "mp4" | "webm";
    codec: string;
    fps: number;
    width: number;
    height: number;
    quality?: string | null;
    graphicsQuality?: string | null;
    purpose?: string | null;
  };
}

export function createExportRecord(input: CreateExportInput): PieceExportRow {
  const [row] = getDb()
    .insert(pieceExports)
    .values({
      id: input.id ?? newExportId(),
      pieceId: input.pieceId,
      jobId: input.jobId ?? null,
      name: input.name,
      relPath: null,
      status: "queued",
      queuedAt: new Date(),
      aspect: aspectOf(input.settings.width, input.settings.height),
      container: input.settings.format,
      codec: input.settings.codec,
      fps: input.settings.fps,
      quality: input.settings.quality ?? null,
      graphicsQuality: input.settings.graphicsQuality ?? null,
      purpose: input.settings.purpose ?? null,
      source: input.source,
    })
    .returning()
    .all();
  exportLogger.info({ op: "record_create", exportId: row.id, pieceId: row.pieceId, source: row.source }, "export.record_create");
  emitExportsChanged(row.pieceId, row.id, "queued");
  return row;
}

export function getExportRecord(id: string): PieceExportRow | null {
  return getDb().select().from(pieceExports).where(eq(pieceExports.id, id)).get() ?? null;
}

export function listExportRecords(pieceId: string): PieceExportRow[] {
  return getDb().select().from(pieceExports).where(eq(pieceExports.pieceId, pieceId)).orderBy(asc(pieceExports.queuedAt)).all();
}

/** Every row still queued or running, of every piece, oldest first. */
export function listActiveExportRecords(): PieceExportRow[] {
  return getDb()
    .select()
    .from(pieceExports)
    .where(inArray(pieceExports.status, ["queued", "running"]))
    .orderBy(asc(pieceExports.queuedAt))
    .all();
}

function updateRecord(id: string, set: Partial<typeof pieceExports.$inferInsert>, op: string): PieceExportRow | null {
  const [row] = getDb().update(pieceExports).set(set).where(eq(pieceExports.id, id)).returning().all();
  if (!row) return null;
  exportLogger.info({ op, exportId: id, pieceId: row.pieceId, status: row.status }, `export.${op}`);
  emitExportsChanged(row.pieceId, id, row.status);
  return row;
}

export function setExportJob(id: string, jobId: string): boolean {
  return updateRecord(id, { jobId }, "record_job") !== null;
}

export function markExportRunning(id: string, jobId: string): boolean {
  return updateRecord(id, { status: "running", jobId, startedAt: new Date(), completedAt: null, error: null }, "record_running") !== null;
}

export function setExportFile(id: string, file: { name: string; relPath: string }): boolean {
  return updateRecord(id, { name: file.name, relPath: file.relPath }, "record_file") !== null;
}

/** What a finished export reports — `ExportResult` (lib/jobs/runners/export.ts) satisfies it. */
export interface ExportDoneFacts {
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  backend: string;
  /** REQUIRED: it is what says whether the file carries a copyrighted song. */
  audioDecision: AudioDecision;
  droppedOverlays?: DroppedOverlay[];
}

export const NO_AUDIO_DECISION_MESSAGE = "libi could not tell which audio this export carries. Export it again.";

/**
 * False when the row is gone (deleted while it rendered). Throws when the
 * caller reports no audio decision: a finished row with no `carriesCopyrighted`
 * would read as song-free, and the copyright checks trust that column — so the
 * export fails (the runner marks it) instead of being recorded as clean.
 */
export function markExportDone(id: string, facts: ExportDoneFacts): boolean {
  if (!facts.audioDecision) {
    exportLogger.error({ op: "record_done_refused", exportId: id }, "export.record_done_refused");
    throw new Error(NO_AUDIO_DECISION_MESSAGE);
  }
  return (
    updateRecord(
      id,
      {
        status: "done",
        completedAt: new Date(),
        error: null,
        sizeBytes: facts.sizeBytes,
        durationSec: facts.durationSeconds,
        width: facts.width,
        height: facts.height,
        aspect: aspectOf(facts.width, facts.height),
        backend: facts.backend,
        purpose: facts.audioDecision.purpose,
        carriesCopyrighted: facts.audioDecision.carriesCopyrighted,
        excludedFileIds: JSON.stringify(facts.audioDecision.excludedFileIds),
        droppedOverlays: facts.droppedOverlays?.length ? JSON.stringify(facts.droppedOverlays) : null,
      },
      "record_done",
    ) !== null
  );
}

/**
 * `error` is the user-facing message; it is stored, never logged.
 *
 * `relPath` is released: the runner has removed the partial file, so a failed
 * row must not keep a claim on a path another export may own by now (a delete
 * of this row would otherwise remove THEIR file).
 */
export function markExportFailed(id: string, error: string): boolean {
  return updateRecord(id, { status: "failed", error, completedAt: new Date(), relPath: null }, "record_failed") !== null;
}

/** Releases `relPath` for the same reason as `markExportFailed`. */
export function markExportCancelled(id: string): boolean {
  return updateRecord(id, { status: "cancelled", completedAt: new Date(), relPath: null }, "record_cancelled") !== null;
}

/** Removes the ROW only; lib/exports/actions.ts#removeExport also cancels and removes the file. */
export function deleteExportRecord(id: string): PieceExportRow | null {
  const [row] = getDb().delete(pieceExports).where(eq(pieceExports.id, id)).returning().all();
  if (!row) return null;
  exportLogger.info({ op: "record_delete", exportId: id, pieceId: row.pieceId }, "export.record_delete");
  emitExportsChanged(row.pieceId, id, "deleted");
  return row;
}

/**
 * A queued/running row whose job ended without the runner saying so — a
 * cancel before the job ever started (the runner never ran), or a job row that
 * is gone. `null` = nothing to reconcile. Pure.
 */
export function staleStatus(
  row: Pick<PieceExportRow, "status" | "queuedAt" | "jobId">,
  job: Pick<JobRecord, "status" | "error"> | null,
  now: number,
): { status: "failed" | "cancelled"; error: string | null } | null {
  if (row.status !== "queued" && row.status !== "running") return null;
  if (job) {
    if (job.status === "cancelled") return { status: "cancelled", error: null };
    if (job.status === "failed") return { status: "failed", error: job.error ?? "The export failed." };
    return null;
  }
  if (now - row.queuedAt.getTime() < UNCLAIMED_GRACE_MS) return null;
  return { status: "failed", error: LOST_EXPORT_MESSAGE };
}

/** Called once at boot (lib/server/lifecycle/category-b.ts): nothing in this process will finish them. */
export async function recoverOrphanedExports(processStartedAt: number): Promise<number> {
  const rows = getDb().select().from(pieceExports).where(inArray(pieceExports.status, ["queued", "running"])).all();
  let recovered = 0;
  for (const row of rows) {
    if (row.queuedAt.getTime() >= processStartedAt) continue;
    if (row.relPath) {
      try {
        fs.rmSync(await absoluteExportPath(row.pieceId, row.relPath), { force: true });
      } catch {
        // A path that no longer resolves has nothing to remove.
      }
    }
    updateRecord(row.id, { status: "failed", error: RESTARTED_EXPORT_MESSAGE, completedAt: new Date(), relPath: null }, "record_recovered");
    recovered++;
  }
  return recovered;
}

function parseArray<T>(json: string | null): T[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * The row's status reconciled against its job, for a READ only — never
 * writes, never emits (controller amendment #4). When the row is stale this
 * returns a NEW in-memory object with the derived status; the persisted row
 * is untouched. Only the runner, `removeExport` and `recoverOrphanedExports`
 * actually persist a reconciled cancelled/failed status.
 */
function reconcile(row: PieceExportRow, job: JobRecord | null, now: number): PieceExportRow {
  const stale = staleStatus(row, job, now);
  if (!stale) return row;
  return { ...row, status: stale.status, error: stale.error };
}

/** The route shape of a row. `job` is its export job (for live progress); `pieceName` for toasts. */
export async function toExportView(row: PieceExportRow, job: JobRecord | null, pieceName: string | null): Promise<ExportRecordView> {
  const abs = row.relPath ? await absoluteExportPath(row.pieceId, row.relPath) : null;
  const active = row.status === "queued" || row.status === "running";
  const snap = active && job ? snapshotFromRow(job) : null;
  // The scheduler knows WHY (memory, cpu, encoder, cap, queue); the job's unit is the fallback.
  const scheduled = active ? getExportScheduler().waitingInfo(row.id) : null;
  // The job-unit fallback is for a QUEUED row only: once admitted the scheduler's entry is gone
  // while the job's unit can still read "waiting" for a moment (reportProgress is debounced).
  const waiting: ExportWaiting | null =
    scheduled ??
    (row.status === "queued" && snap && snap.progressUnit === EXPORT_WAITING_UNIT ? { reason: "queue", message: EXPORT_WAITING_MESSAGE } : null);
  return {
    id: row.id,
    pieceId: row.pieceId,
    pieceName,
    jobId: row.jobId,
    name: row.name,
    fileName: row.relPath ? row.relPath.split("/").pop() ?? null : null,
    path: abs,
    status: row.status,
    missing: row.status === "done" && (!abs || !fs.existsSync(abs)),
    error: row.error,
    queuedAt: row.queuedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
    sizeBytes: row.sizeBytes,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    aspect: row.aspect,
    container: row.container,
    codec: row.codec,
    fps: row.fps,
    quality: row.quality,
    graphicsQuality: row.graphicsQuality,
    purpose: row.purpose,
    carriesCopyrighted: row.carriesCopyrighted,
    excludedFileIds: parseArray<string>(row.excludedFileIds) ?? [],
    backend: row.backend,
    droppedOverlays: parseArray<DroppedOverlay>(row.droppedOverlays),
    source: row.source,
    progress: snap ? { done: snap.progressDone, total: snap.progressTotal, unit: snap.progressUnit, etaMs: snap.etaMs } : null,
    waiting,
  };
}

function jobsFor(rows: PieceExportRow[]): Map<string, JobRecord> {
  const ids = rows.map((r) => r.jobId).filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  return new Map(getDb().select().from(jobs).where(inArray(jobs.id, ids)).all().map((j) => [j.id, j]));
}

function pieceNameOf(pieceId: string): string | null {
  return getDb().select({ name: pieces.name }).from(pieces).where(eq(pieces.id, pieceId)).get()?.name ?? null;
}

/** READ-ONLY: reconciles each row against its job for the view it returns, but never persists the derived status and never emits. */
export async function listExportViews(pieceId: string): Promise<ExportRecordView[]> {
  const rows = listExportRecords(pieceId);
  const byJob = jobsFor(rows);
  const name = pieceNameOf(pieceId);
  const now = Date.now();
  return Promise.all(
    rows.map((r) => {
      const job = r.jobId ? byJob.get(r.jobId) ?? null : null;
      return toExportView(reconcile(r, job, now), job, name);
    }),
  );
}

/**
 * Every queued/running export of every piece, oldest first — the editor's
 * running-count badges. READ-ONLY like `listExportViews`: a row whose job is
 * gone is reconciled for this answer (and so left out) but never persisted.
 */
export async function listActiveExportViews(): Promise<ExportRecordView[]> {
  const rows = listActiveExportRecords();
  const byJob = jobsFor(rows);
  const names = new Map<string, string | null>();
  const now = Date.now();
  const views = await Promise.all(
    rows.map((r) => {
      if (!names.has(r.pieceId)) names.set(r.pieceId, pieceNameOf(r.pieceId));
      const job = r.jobId ? byJob.get(r.jobId) ?? null : null;
      return toExportView(reconcile(r, job, now), job, names.get(r.pieceId) ?? null);
    }),
  );
  return views.filter((v) => v.status === "queued" || v.status === "running");
}

/** READ-ONLY: see `listExportViews`. */
export async function getExportView(id: string): Promise<ExportRecordView | null> {
  const row = getExportRecord(id);
  if (!row) return null;
  const job = row.jobId ? jobsFor([row]).get(row.jobId) ?? null : null;
  return toExportView(reconcile(row, job, Date.now()), job, pieceNameOf(row.pieceId));
}

/**
 * The newest DONE export whose file is `absPath` — how a bare path learns
 * which audio it carries (a template example from `{ path }`). Null for a
 * file libi never exported (or one outside every piece's exports folder).
 */
export async function doneExportForPath(absPath: string): Promise<PieceExportRow | null> {
  const want = path.resolve(absPath);
  const rows = getDb()
    .select()
    .from(pieceExports)
    .where(eq(pieceExports.status, "done"))
    .orderBy(desc(pieceExports.completedAt))
    .all();
  for (const row of rows) {
    if (!row.relPath) continue;
    if (path.resolve(await absoluteExportPath(row.pieceId, row.relPath)) === want) return row;
  }
  return null;
}
