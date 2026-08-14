"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics/client";

export type ExportSource = "draft" | "snapshot";
export type ExportQuality = "source" | "1080p" | "1440p" | "4k" | "custom";
export type ExportFormat = "mp4" | "webm";

export interface ExportStartParams {
  pieceId: string;
  source: ExportSource;
  filename: string;
  format: ExportFormat;
  quality: ExportQuality;
  customWidth?: number;
  customHeight?: number;
  destFolder?: string;
}

export interface ExportProgress {
  done: number;
  total: number;
  unit: string;
  etaMs: number | null;
}

export interface ExportSuccess {
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  backend: string;
  width: number;
  height: number;
}

export type ExportStatus =
  | "idle"
  | "starting"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface UseExportFlowResult {
  status: ExportStatus;
  progress: ExportProgress | null;
  result: ExportSuccess | null;
  error: string | null;
  jobId: string | null;
  start: (params: ExportStartParams) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/**
 * Drives an export through the unified `/api/export` route + JobManager.
 *
 * Lifecycle:
 *   1. start({...}) POSTs the request → { jobId, destFolder, filename, settings }.
 *   2. Hook opens an SSE stream on /api/jobs/<jobId>/events.
 *   3. Progress events tick the `progress` field.
 *   4. completed/failed/cancelled events resolve the flow.
 *
 * Closing the dialog mid-export does NOT cancel — the SSE stream stays open
 * for the lifetime of the component using this hook. Explicit cancel() does
 * a DELETE on the job, which propagates through JobManager → ffmpeg SIGKILL
 * + partial-file unlink.
 */
export function useExportFlow(): UseExportFlowResult {
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanupStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);

  const start = useCallback(
    async (params: ExportStartParams) => {
      if (status === "starting" || status === "running") return;
      cleanupStream();
      setStatus("starting");
      setProgress(null);
      setResult(null);
      setError(null);
      setJobId(null);

      let enq: { jobId: string };
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
            customWidth: params.customWidth,
            customHeight: params.customHeight,
            destFolder: params.destFolder,
          }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          setStatus("failed");
          setError(body || `HTTP ${resp.status}`);
          return;
        }
        enq = (await resp.json()) as { jobId: string };
      } catch (err) {
        setStatus("failed");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      setJobId(enq.jobId);
      setStatus("running");
      trackEvent("export_started", { format: params.format, quality: params.quality });
      const es = new EventSource(`/api/jobs/${enq.jobId}/events`);
      eventSourceRef.current = es;

      es.addEventListener("progress", (ev) => {
        try {
          const p = JSON.parse((ev as MessageEvent).data) as {
            done: number;
            total: number;
            unit: string;
            etaMs: number | null;
          };
          setProgress({ done: p.done, total: p.total, unit: p.unit, etaMs: p.etaMs });
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("completed", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            result?: ExportSuccess;
          };
          if (data.result) setResult(data.result);
          trackEvent("export_completed", {
            backend: data.result?.backend ?? "unknown",
            format: params.format,
            quality: params.quality,
          });
          void fetch("/api/analytics/milestone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "export", event: "first_export" }),
          }).catch(() => {});
          setStatus("success");
        } catch {
          setStatus("success");
        } finally {
          cleanupStream();
        }
      });

      es.addEventListener("failed", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { error?: string };
          setError(data.error ?? "Export failed");
        } catch {
          setError("Export failed");
        }
        setStatus("failed");
        cleanupStream();
      });

      es.addEventListener("cancelled", () => {
        setStatus("cancelled");
        cleanupStream();
      });

      es.onerror = () => {
        // Browser fires onerror when the server closes the stream after
        // emitting a terminal event — that's normal, not a failure. The
        // terminal `completed`/`failed`/`cancelled` listeners run first
        // and set the final status; no action needed here.
      };
    },
    [status, cleanupStream],
  );

  const cancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    } catch {
      /* ignore — the SSE stream will surface the cancel/failure */
    }
  }, [jobId]);

  const reset = useCallback(() => {
    cleanupStream();
    setStatus("idle");
    setProgress(null);
    setResult(null);
    setError(null);
    setJobId(null);
  }, [cleanupStream]);

  return { status, progress, result, error, jobId, start, cancel, reset };
}
