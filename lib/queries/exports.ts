"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isActiveExport, type ExportRecordView } from "@/lib/exports/types";

export const exportKeys = {
  /** Every exports query — what `refresh_query { queryKey: "exports" }` invalidates. */
  all: ["exports"] as const,
  forPiece: (pieceId: string) => ["exports", "piece", pieceId] as const,
  byId: (exportId: string) => ["exports", "by-id", exportId] as const,
  active: () => ["exports", "active"] as const,
};

/** A refusal body's human line: `message`, else `error`, else the status. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.error === "string" && body.error) return body.error;
  return `Request failed (${res.status}).`;
}

/**
 * A piece's exports, every status, oldest first. Invalidated by the one SSE
 * (`refresh_query exports`), and polled every 2 s only while one is queued or
 * running — progress ticks are not broadcast.
 */
export function useExports(pieceId: string | null) {
  return useQuery({
    queryKey: exportKeys.forPiece(pieceId ?? ""),
    enabled: !!pieceId,
    queryFn: async (): Promise<ExportRecordView[]> => {
      const res = await fetch(`/api/pieces/${encodeURIComponent(pieceId ?? "")}/exports`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error("Failed to load exports");
      const data = (await res.json()) as { exports?: ExportRecordView[] };
      return data.exports ?? [];
    },
    refetchInterval: (query) => {
      const rows = query.state.data as ExportRecordView[] | undefined;
      return rows?.some(isActiveExport) ? 2000 : false;
    },
  });
}

/** The export's absolute path now, or null when the row is gone. */
export async function fetchExportLocation(exportId: string): Promise<{ path: string; exists: boolean } | null> {
  const res = await fetch(`/api/exports/${encodeURIComponent(exportId)}/location`);
  if (!res.ok) return null;
  return (await res.json()) as { path: string; exists: boolean };
}

export function useRenameExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ exportId, name }: { exportId: string; name: string }): Promise<ExportRecordView> => {
      const res = await fetch(`/api/exports/${encodeURIComponent(exportId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await refusal(res));
      return ((await res.json()) as { export: ExportRecordView }).export;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: exportKeys.all }),
  });
}

export function useDeleteExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (exportId: string): Promise<void> => {
      const res = await fetch(`/api/exports/${encodeURIComponent(exportId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await refusal(res));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: exportKeys.all }),
  });
}

/** Every queued/running export of every piece. Polled every 2 s only while there is one. */
export function useActiveExports() {
  return useQuery({
    queryKey: exportKeys.active(),
    queryFn: async (): Promise<ExportRecordView[]> => {
      const res = await fetch("/api/exports");
      if (!res.ok) throw new Error("Failed to load running exports");
      return ((await res.json()) as { exports?: ExportRecordView[] }).exports ?? [];
    },
    refetchInterval: (query) => ((query.state.data as ExportRecordView[] | undefined)?.length ? 2000 : false),
  });
}

/** The open piece's most recently queued export that is rendering now — the canvas progress bar. */
export function useLatestRunningExport(pieceId: string | null): ExportRecordView | null {
  const { data } = useExports(pieceId);
  return useMemo(
    () => (data ?? []).filter((e) => e.status === "running").sort((a, b) => b.queuedAt - a.queuedAt)[0] ?? null,
    [data],
  );
}
