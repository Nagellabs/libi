/**
 * Client-safe shapes for a piece's exports (spec 2026-09-29 §A1). The DB row
 * lives in `piece_exports` (lib/db/schema/sqlite.ts) and is read through
 * lib/exports/store.ts; this file is what the routes send, what the UI and the
 * MCP child read — no DB, no node imports.
 */
import type { DroppedOverlay } from "@/lib/export/dropped-overlays";

export const EXPORT_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type ExportRecordStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_ASPECTS = ["9:16", "16:9", "1:1", "4:5", "other"] as const;
export type ExportAspect = (typeof EXPORT_ASPECTS)[number];

/** Who started the export: the user from libi's page, or an agent/tool. */
export type ExportStartedBy = "user" | "agent";

export const EXPORT_WAIT_REASONS = ["memory", "cpu", "encoder", "cap", "queue"] as const;
export type ExportWaitReason = (typeof EXPORT_WAIT_REASONS)[number];

export interface ExportWaiting {
  reason: ExportWaitReason;
  /** One user-facing line, e.g. "Waiting for memory — 2 exports running". */
  message: string;
}

export interface ExportProgressView {
  done: number;
  total: number;
  unit: string;
  etaMs: number | null;
}

/** One export as every route answers it. Times are epoch milliseconds. */
export interface ExportRecordView {
  id: string;
  pieceId: string;
  pieceName: string | null;
  jobId: string | null;
  /** Display name = the file's stem. */
  name: string;
  /** `Summer promo.mp4`; null until the file is claimed. */
  fileName: string | null;
  /** Absolute path of the file; null until claimed. */
  path: string | null;
  status: ExportRecordStatus;
  /** `status: "done"` but the file is not on disk any more. */
  missing: boolean;
  error: string | null;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  sizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  aspect: ExportAspect;
  container: "mp4" | "webm";
  codec: string;
  fps: number;
  quality: string | null;
  graphicsQuality: string | null;
  purpose: string | null;
  carriesCopyrighted: boolean;
  excludedFileIds: string[];
  backend: string | null;
  droppedOverlays: DroppedOverlay[] | null;
  source: ExportStartedBy;
  /** Live job progress, for a queued/running export only. */
  progress: ExportProgressView | null;
  /** Why a queued/running export is not rendering yet; null when it is. */
  waiting: ExportWaiting | null;
}

/** An old caller's `destFolder` is refused with this, never silently ignored. */
export const DEST_FOLDER_REFUSAL =
  "destFolder is not supported any more: exports are saved in the piece; use libi.list_exports to find them.";

export const MISSING_FILE_MESSAGE = "Missing file: this export is no longer on disk. You can only delete it.";

export function isActiveExport(e: Pick<ExportRecordView, "status">): boolean {
  return e.status === "queued" || e.status === "running";
}

/** `export_queued`'s bounded `variants` param: how many exports one request queued. */
export function variantsBucket(n: number): "1" | "2-3" | "4+" {
  if (n >= 4) return "4+";
  if (n >= 2) return "2-3";
  return "1";
}
