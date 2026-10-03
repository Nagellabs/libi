/**
 * `libi.list_exports` — a piece's exports as the user sees them in its
 * Exports tab (spec 2026-09-29 §B3; shipped with Part A because the
 * destFolder refusal points here). Reads the studio's route over HTTP — the
 * MCP child never touches the DB.
 */
import { notify } from "@/mcp/notify";
import type { ExportRecordStatus, ExportRecordView } from "@/lib/exports/types";
import { activePercent } from "@/lib/exports/list-view";
import { api } from "./social-http";
import type { ListExportsParams, ShowExportParams } from "./schemas";
import type { ToolResult } from "./types";

/** One export in the tool's answer. Times are ISO strings. */
export interface AgentExportRow {
  exportId: string;
  name: string;
  status: ExportRecordStatus;
  /** The file, once done. */
  path: string | null;
  /** Done, but the file is no longer on disk. */
  missing: boolean;
  format: "mp4" | "webm";
  width: number | null;
  height: number | null;
  aspect: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  queuedAt: string;
  completedAt: string | null;
  carriesCopyrightedMusic: boolean;
  /** A rendering export's progress, 0–100. */
  percent: number | null;
  /** Why a queued export has not started yet. */
  waiting: string | null;
  error: string | null;
  startedBy: "user" | "agent";
}

export function toAgentRow(e: ExportRecordView): AgentExportRow {
  return {
    exportId: e.id,
    name: e.name,
    status: e.status,
    path: e.path,
    missing: e.missing,
    format: e.container,
    width: e.width,
    height: e.height,
    aspect: e.aspect,
    sizeBytes: e.sizeBytes,
    durationSeconds: e.durationSec,
    queuedAt: new Date(e.queuedAt).toISOString(),
    completedAt: e.completedAt !== null ? new Date(e.completedAt).toISOString() : null,
    carriesCopyrightedMusic: e.carriesCopyrighted,
    percent: activePercent(e),
    waiting: e.waiting?.message ?? null,
    error: e.error,
    startedBy: e.source,
  };
}

export async function listExports(params: ListExportsParams): Promise<ToolResult> {
  const res = await api<{ exports: ExportRecordView[] }>(`/api/pieces/${encodeURIComponent(params.pieceId)}/exports`);
  if (!res.ok) {
    if (res.status === 404) return { success: false, error: "piece_not_found", data: { hint: `No piece with id ${params.pieceId}.` } };
    return { success: false, error: "libi_server_unavailable", data: { hint: res.body.message ?? "libi's server did not answer.", status: res.status } };
  }
  const rows = (res.body.exports ?? []).filter((e) => !params.status || e.status === params.status).map(toAgentRow);
  if (params.show) notify.navigate({ target: "exports", pieceId: params.pieceId });
  return {
    success: true,
    data: {
      pieceId: params.pieceId,
      exports: rows as unknown as Record<string, unknown>[],
      note:
        rows.length === 0
          ? "No exports match. Exports are saved inside the piece; the user sees them in its Exports tab."
          : "Exports are saved inside the piece; the user sees them in its Exports tab. A done row's `path` is the file.",
    },
  };
}

/**
 * `libi.show` target `export` — open the piece's Exports tab on ONE export.
 * Proven before navigating, like the other show targets (navigation-tools.ts):
 * the editor is told to move only when the piece and the export exist, so the
 * agent never claims a screen the user is not looking at. A cancelled export is
 * hidden from the tab (and from every list), so it counts as not found.
 */
export async function showExport(params: ShowExportParams): Promise<ToolResult> {
  const res = await api<{ exports: ExportRecordView[] }>(`/api/pieces/${encodeURIComponent(params.pieceId)}/exports`);
  if (!res.ok) {
    if (res.status === 404) {
      return {
        success: false,
        error: "piece_not_found",
        data: { hint: `No piece "${params.pieceId}". Do not tell the user the export is on screen. Use libi.list_pieces to see what exists.` },
      };
    }
    return { success: false, error: "libi_server_unavailable", data: { hint: res.body.message ?? "libi's server did not answer.", status: res.status } };
  }
  const found = (res.body.exports ?? []).find((e) => e.id === params.exportId && e.status !== "cancelled");
  if (!found) {
    return {
      success: false,
      error: "export_not_found",
      data: {
        hint: `No export "${params.exportId}" in piece "${params.pieceId}" (a cancelled export is removed from the Exports tab). Do not tell the user it is on screen. Use libi.list_exports to see the piece's exports.`,
      },
    };
  }
  notify.navigate({ target: "exports", pieceId: params.pieceId, id: found.id });
  return { success: true, data: { navigated: true, pieceId: params.pieceId, exportId: found.id, name: found.name, status: found.status } };
}
