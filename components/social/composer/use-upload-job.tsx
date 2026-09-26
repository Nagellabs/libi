"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UploadResult {
  publicUrl: string;
  expiresAt: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
}

export interface UploadState {
  status: "idle" | "running" | "done" | "failed";
  percent: number;
  result: UploadResult | null;
  error: string | null;
}

export interface UseUploadJobResult extends UploadState {
  /** Upload this export once. A second call for the same path returns the
   *  cached result (or joins the in-flight one) instead of re-uploading. */
  start: (exportPath: string, pieceId: string) => Promise<UploadResult>;
}

/** Re-upload when the provider's URL has less than this left: attaching the
 *  file is what promotes it out of `temp/`, and that happens at submit time,
 *  not now. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * `POST /api/social/upload` once per export path, then follow that job's own
 * SSE stream for progress — the same per-job stream the export dialog reads
 * (`hooks/editor/use-export-flow.ts`), with the same NAMED events
 * (`progress` / `completed` / `failed` / `cancelled`). This is not a second
 * global SSE connection: it is one stream per job, opened while the job runs
 * and closed the moment it ends.
 */
export function useUploadJob(): UseUploadJobResult {
  const [state, setState] = useState<UploadState>({ status: "idle", percent: 0, result: null, error: null });
  const cache = useRef<Map<string, UploadResult>>(new Map());
  const inflight = useRef<Map<string, Promise<UploadResult>>>(new Map());
  const streams = useRef<Set<EventSource>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // The Set itself never changes identity; copying it here is what the
    // exhaustive-deps rule asks for and costs nothing.
    const open = streams.current;
    return () => {
      mounted.current = false;
      for (const es of open) es.close();
      open.clear();
    };
  }, []);

  const set = useCallback((s: UploadState) => {
    if (mounted.current) setState(s);
  }, []);

  const run = useCallback(
    async (exportPath: string, pieceId: string): Promise<UploadResult> => {
      set({ status: "running", percent: 0, result: null, error: null });
      const res = await fetch("/api/social/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportPath, pieceId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        const message = body.message ?? body.error ?? `HTTP ${res.status}`;
        set({ status: "failed", percent: 0, result: null, error: message });
        throw new Error(message);
      }
      const body = (await res.json()) as { jobId: string; reused?: boolean; result?: UploadResult };
      // The route found a completed upload for this exact file and reused it
      // (`app/api/social/upload/route.ts`). That job is terminal, so there is
      // no stream left to open — waiting on one would hang the composer for
      // ever on events that already happened.
      if (body.reused && body.result?.publicUrl) {
        cache.current.set(exportPath, body.result);
        set({ status: "done", percent: 100, result: body.result, error: null });
        return body.result;
      }
      const { jobId } = body;

      return new Promise<UploadResult>((resolve, reject) => {
        const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
        streams.current.add(es);
        const close = () => {
          es.close();
          streams.current.delete(es);
        };
        const fail = (message: string) => {
          set({ status: "failed", percent: 0, result: null, error: message });
          close();
          reject(new Error(message));
        };

        es.addEventListener("progress", (ev) => {
          try {
            const p = JSON.parse((ev as MessageEvent).data) as { done?: number; total?: number };
            if (!p.total) return;
            const percent = Math.min(100, Math.round((100 * (p.done ?? 0)) / p.total));
            if (mounted.current) setState((s) => ({ ...s, status: "running", percent }));
          } catch {
            /* a frame we can't read is not a failure */
          }
        });

        es.addEventListener("completed", (ev) => {
          let result: UploadResult | undefined;
          try {
            result = (JSON.parse((ev as MessageEvent).data) as { result?: UploadResult }).result;
          } catch {
            /* handled below */
          }
          if (!result?.publicUrl) {
            fail("the upload finished without a media URL");
            return;
          }
          cache.current.set(exportPath, result);
          set({ status: "done", percent: 100, result, error: null });
          close();
          resolve(result);
        });

        es.addEventListener("failed", (ev) => {
          let message = "the upload failed";
          try {
            message = (JSON.parse((ev as MessageEvent).data) as { error?: string }).error ?? message;
          } catch {
            /* keep the default */
          }
          fail(message);
        });

        es.addEventListener("cancelled", () => fail("the upload was cancelled"));

        // A browser fires `onerror` when the server closes a stream after its
        // terminal event, which the listeners above have already handled —
        // so this only matters while the job is still open.
        es.onerror = () => {
          if (es.readyState === 2 /* CLOSED */ && streams.current.has(es)) fail("the upload stream closed");
        };
      });
    },
    [set],
  );

  const start = useCallback(
    (exportPath: string, pieceId: string): Promise<UploadResult> => {
      const hit = cache.current.get(exportPath);
      if (hit && new Date(hit.expiresAt).getTime() > Date.now() + EXPIRY_MARGIN_MS) {
        set({ status: "done", percent: 100, result: hit, error: null });
        return Promise.resolve(hit);
      }
      const running = inflight.current.get(exportPath);
      if (running) return running;
      const p = run(exportPath, pieceId).finally(() => inflight.current.delete(exportPath));
      inflight.current.set(exportPath, p);
      return p;
    },
    [run, set],
  );

  return { ...state, start };
}
