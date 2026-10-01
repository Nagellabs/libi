/**
 * Rename and delete of an export (spec 2026-09-29 §A6). Server only. Kept out
 * of lib/exports/store.ts because removing a queued/running export cancels its
 * job through JobManager, and the export runner itself imports the store.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs, pieceExports, socialPostLinks } from "@/lib/db/schema/sqlite";
import type { PieceExportRow } from "@/lib/db/schema/types";
import { sanitizeFilename } from "@/lib/export/filename";
import { getJobManager } from "@/lib/jobs/manager";
import { exportLogger } from "@/lib/logger";
import { isUnsafeStorageName, isWindowsHazard } from "@/lib/storage/safe-name";
import { absoluteExportPath, relPathFor } from "./paths";
import { deleteExportRecord, emitExportsChanged, getExportRecord, uniqueExportName } from "./store";
import { MISSING_FILE_MESSAGE } from "./types";

export type ExportChangeResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409 | 500; code: string; message: string };

export const EXPORT_NOT_FOUND = "That export does not exist any more.";
export const RENAME_NOT_DONE = "Only a finished export can be renamed.";
export const BAD_EXPORT_NAME = "That name can't be a file name. Use letters, numbers, spaces, - or _ (up to 200 characters).";
export const UPLOADING_RENAME = "This export is uploading to social right now. Rename it when the upload finishes.";
export const UPLOADING_DELETE = "This export is uploading to social right now. Delete it when the upload finishes.";
export const RENAME_FAILED = "The export could not be renamed. Nothing was changed.";

const MAX_NAME_LENGTH = 200;
const notFound: ExportChangeResult = { ok: false, status: 404, code: "not_found", message: EXPORT_NOT_FOUND };

/** The name as typed, when it can be a file stem as-is; null when it can't (refused, never rewritten). */
export function validExportName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  if (isUnsafeStorageName(name) || isWindowsHazard(name)) return null;
  return sanitizeFilename(name) === name ? name : null;
}

/** A `social-upload` job for this very file is queued or running. */
export function uploadInFlight(absPath: string): boolean {
  const want = path.resolve(absPath);
  const rows = getDb()
    .select({ paramsJson: jobs.paramsJson })
    .from(jobs)
    .where(and(eq(jobs.kind, "social-upload"), inArray(jobs.status, ["queued", "running", "cancel-requested"])))
    .all();
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.paramsJson) as { exportPath?: unknown };
      return typeof p.exportPath === "string" && path.resolve(p.exportPath) === want;
    } catch {
      return false;
    }
  });
}

/**
 * Rename in one step: the FILE first (so a DB row never names a file that is
 * not there), then the row and the social post links that point at the old
 * path, in one transaction; a failed transaction renames the file back.
 */
export async function renameExport(id: string, rawName: string): Promise<ExportChangeResult> {
  const row = getExportRecord(id);
  if (!row) return notFound;
  if (row.status !== "done" || !row.relPath) return { ok: false, status: 409, code: "not_done", message: RENAME_NOT_DONE };
  const wanted = validExportName(rawName);
  if (!wanted) return { ok: false, status: 400, code: "bad_name", message: BAD_EXPORT_NAME };
  if (wanted === row.name) return { ok: true };
  const oldAbs = await absoluteExportPath(row.pieceId, row.relPath);
  if (!fs.existsSync(oldAbs)) return { ok: false, status: 409, code: "missing", message: MISSING_FILE_MESSAGE };
  if (uploadInFlight(oldAbs)) return { ok: false, status: 409, code: "uploading", message: UPLOADING_RENAME };

  const ext = path.extname(row.relPath);
  const name = await uniqueExportName(row.pieceId, wanted, ext.slice(1), { exceptId: id });
  const fileName = `${name}${ext}`;
  const relPath = relPathFor(fileName);
  const newAbs = await absoluteExportPath(row.pieceId, relPath);
  fs.renameSync(oldAbs, newAbs);
  try {
    getDb().transaction((tx) => {
      tx.update(pieceExports).set({ name, relPath }).where(eq(pieceExports.id, id)).run();
      tx.update(socialPostLinks).set({ exportPath: newAbs }).where(eq(socialPostLinks.exportPath, oldAbs)).run();
    });
  } catch (err) {
    fs.renameSync(newAbs, oldAbs);
    exportLogger.warn(
      { op: "record_rename_failed", exportId: id, pieceId: row.pieceId, error: err instanceof Error ? err.message : String(err) },
      "export.record_rename_failed",
    );
    return { ok: false, status: 500, code: "rename_failed", message: RENAME_FAILED };
  }
  exportLogger.info({ op: "record_rename", exportId: id, pieceId: row.pieceId }, "export.record_rename");
  // "renamed", never "done": a finish toast listens for "done".
  emitExportsChanged(row.pieceId, id, "renamed");
  return { ok: true };
}

/**
 * Whether deleting this row may delete the file its `relPath` names. Only a
 * finished or an active row holds a claim on its file: a failed or cancelled
 * row's partial was already removed by the runner, and its name has been free
 * since, so another export may own the path now. Even a row that looks like
 * it holds one yields to any OTHER live row naming the same path.
 */
function ownsItsFile(row: PieceExportRow, id: string): boolean {
  if (row.status === "failed" || row.status === "cancelled") return false;
  const other = getDb()
    .select({ id: pieceExports.id })
    .from(pieceExports)
    .where(and(eq(pieceExports.pieceId, row.pieceId), eq(pieceExports.relPath, row.relPath ?? ""), ne(pieceExports.id, id), ne(pieceExports.status, "cancelled")))
    .get();
  if (!other) return true;
  exportLogger.warn(
    { op: "record_delete_file_kept", exportId: id, otherExportId: other.id, pieceId: row.pieceId },
    "export.record_delete_file_kept",
  );
  return false;
}

/**
 * Delete: a queued/running export is cancelled first (its job, then the row
 * and any partial file). Refused while a social upload of the file is in
 * flight. Social post links keep their stored path — the post is already out.
 */
export async function removeExport(id: string): Promise<ExportChangeResult> {
  const row = getExportRecord(id);
  if (!row) return notFound;
  const abs = row.relPath ? await absoluteExportPath(row.pieceId, row.relPath) : null;
  if (abs && row.status === "done" && uploadInFlight(abs)) {
    return { ok: false, status: 409, code: "uploading", message: UPLOADING_DELETE };
  }
  if ((row.status === "queued" || row.status === "running") && row.jobId) {
    try {
      await getJobManager().cancel(row.jobId);
    } catch {
      // The job row is gone — nothing left to cancel.
    }
  }
  deleteExportRecord(id);
  if (abs && ownsItsFile(row, id)) {
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      // The row is already gone. On Windows a file ffmpeg still has open (it does not
      // share DELETE; the runner's own claim handle does) throws EBUSY/EPERM;
      // the runner's catch removes the partial later.
      exportLogger.warn(
        { op: "record_delete_file_failed", exportId: id, pieceId: row.pieceId, error: err instanceof Error ? err.message : String(err) },
        "export.record_delete_file_failed",
      );
    }
  }
  return { ok: true };
}
