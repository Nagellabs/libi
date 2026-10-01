"use client";

import { useCallback, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics/client";
import type { GraphicsQuality } from "@/lib/engine/types";
import { DEFAULT_GRAPHICS_QUALITY } from "@/lib/export/quality";

export type ExportSource = "draft" | "snapshot";
export type ExportQuality = "source" | "1080p" | "1440p" | "4k" | "custom";
export type ExportFormat = "mp4" | "webm";

export interface ExportStartParams {
  pieceId: string;
  source: ExportSource;
  filename: string;
  format: ExportFormat;
  quality: ExportQuality;
  /** Resolution text/code/3D overlays render at; the server falls back to the stored default. */
  graphicsQuality?: GraphicsQuality;
  customWidth?: number;
  customHeight?: number;
  /** What the export is for (spec §5.3) — decides the copyrighted-audio default. */
  purpose?: "social" | "personal";
  copyrightedAudio?: "exclude" | "include";
  includeFileIds?: string[];
  excludeFileIds?: string[];
}

/** idle → starting → queued (it is the export's record's now) | failed. */
export type ExportStatus = "idle" | "starting" | "queued" | "failed";

export interface QueuedExport {
  exportId: string;
  name: string;
  pieceId: string;
}

export interface UseExportFlowResult {
  status: ExportStatus;
  /** The export the last Start queued. */
  queued: QueuedExport | null;
  error: string | null;
  /** The server refused with `purpose_required`: not an error, the dialog asks what the export is for. */
  purposeRequired: boolean;
  /** The queued export, or null when nothing was queued (refused, failed, or a double click). */
  start: (params: ExportStartParams) => Promise<QueuedExport | null>;
  reset: () => void;
}

export interface UseExportFlowOptions {
  /** Called on a `purpose_required` refusal so the caller can refetch the piece's audio rights. */
  onPurposeRequired?: (pieceId: string) => void;
}

/** A refusal body's human text: `message`, else `error`, else the raw text. */
function refusalText(body: string, status: number): { text: string; code?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const code = typeof parsed.error === "string" ? parsed.error : undefined;
    const text = typeof parsed.message === "string" ? parsed.message : code;
    if (text) return { text, code };
  } catch {
    /* not JSON */
  }
  return { text: body || `HTTP ${status}` };
}

/**
 * Queue an export through `/api/export` (spec 2026-09-29 §B2). Only the
 * enqueue is tracked here: the export's progress, its wait and its finish are
 * on its `piece_exports` record — the Exports tab, the canvas bar
 * (`useLatestRunningExport`) and the finish toast (`useExportFinishToasts`).
 * Nothing blocks a second Start; only a double click on the same one is ignored.
 */
export function useExportFlow(options: UseExportFlowOptions = {}): UseExportFlowResult {
  const { onPurposeRequired } = options;
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [queued, setQueued] = useState<QueuedExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purposeRequired, setPurposeRequired] = useState(false);
  const starting = useRef(false);

  const start = useCallback(
    async (params: ExportStartParams) => {
      if (starting.current) return null;
      starting.current = true;
      setStatus("starting");
      setError(null);
      setPurposeRequired(false);
      try {
        const resp = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pieceId: params.pieceId,
            source: params.source,
            filename: params.filename,
            format: params.format,
            quality: params.quality,
            graphicsQuality: params.graphicsQuality,
            customWidth: params.customWidth,
            customHeight: params.customHeight,
            purpose: params.purpose,
            copyrightedAudio: params.copyrightedAudio,
            includeFileIds: params.includeFileIds,
            excludeFileIds: params.excludeFileIds,
          }),
        });
        if (!resp.ok) {
          const refusal = refusalText(await resp.text(), resp.status);
          if (resp.status === 422 && refusal.code === "purpose_required") {
            setStatus("idle");
            setPurposeRequired(true);
            onPurposeRequired?.(params.pieceId);
            return null;
          }
          setStatus("failed");
          setError(refusal.text);
          return null;
        }
        const enq = (await resp.json()) as { exportId: string; name: string };
        const queuedExport: QueuedExport = { exportId: enq.exportId, name: enq.name, pieceId: params.pieceId };
        setQueued(queuedExport);
        setStatus("queued");
        trackEvent("export_started", {
          format: params.format,
          quality: params.quality,
          graphics_quality: params.graphicsQuality ?? DEFAULT_GRAPHICS_QUALITY,
        });
        return queuedExport;
      } catch (err) {
        setStatus("failed");
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        starting.current = false;
      }
    },
    [onPurposeRequired],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setQueued(null);
    setError(null);
    setPurposeRequired(false);
  }, []);

  return { status, queued, error, purposeRequired, start, reset };
}
