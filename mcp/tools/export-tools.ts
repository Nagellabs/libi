/**
 * Export MCP tools — let the agent trigger a piece export from chat.
 *
 * The tool delegates to the unified `export` JobManager runner via the
 * Next.js HTTP API:
 *   1. POST /api/export  → returns { jobId }
 *   2. Open SSE on /api/jobs/<id>/events to forward progress notifications
 *      to the chat UI as ACP `tool_call_update` events.
 *
 * Cancellation comes from the chat's existing Stop button (sends a job
 * cancel on the underlying jobId).
 */
import { EXPORT_WAITING_MESSAGE, isExportWaiting } from "@/lib/export/export-waiting";
import type { AudioDecision } from "@/lib/export/audio-policy";
import { DEST_FOLDER_REFUSAL } from "@/lib/exports/types";
import { getCurrentPort } from "@/lib/libi-home";
import { LibiServerUnavailableError } from "@/mcp/jobs-client";
import { mcpLogger as logger } from "@/lib/logger";
import { reportToolProgress } from "./tool-progress";
import { frameDroppedOverlay, type FramedDroppedOverlay } from "./body-message";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

/**
 * One export of a `variants` call. Not the social code's `ExportVariant`
 * (`lib/social/music-policy.ts`: with-song | without-song) — that names which
 * audio cut a post uses; this is a whole set of export settings.
 */
export interface ExportVideoVariant {
  format?: "mp4" | "webm";
  quality?: "source" | "1080p" | "1440p" | "4k" | "custom";
  graphicsQuality?: "1080p" | "1440p" | "4k";
  customWidth?: number;
  customHeight?: number;
  filename?: string;
  purpose?: "social" | "personal";
  copyrightedAudio?: "exclude" | "include";
  includeFileIds?: string[];
}

/** What a `variants` call answers per export. */
export interface QueuedExportVariant {
  exportId: string;
  name: string;
  format: "mp4" | "webm";
  width: number;
  height: number;
}

export const VARIANTS_NOTE =
  "Queued. They render in parallel as the machine allows and are saved in the piece — tell the user what you queued and that they appear in the piece's Exports tab. Check progress with libi.list_exports({ pieceId }).";

export interface ExportVideoParams {
  pieceId: string;
  source?: "draft" | "snapshot";
  filename?: string;
  format?: "mp4" | "webm";
  quality?: "source" | "1080p" | "1440p" | "4k" | "custom";
  graphicsQuality?: "1080p" | "1440p" | "4k";
  customWidth?: number;
  customHeight?: number;
  /** Removed — exports are saved in the piece. Kept only so an old caller is refused, never ignored. */
  destFolder?: string;
  purpose?: "social" | "personal";
  copyrightedAudio?: "exclude" | "include";
  includeFileIds?: string[];
  /** Several exports in one call — see `exportVideoVariants`. */
  variants?: ExportVideoVariant[];
}

export interface ExportVideoResult {
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  backend: string;
  width: number;
  height: number;
  /** Echoed back so the agent can show progress / cancellation references. */
  jobId: string;
  /** The export's record — `libi.list_exports` and the piece's Exports tab name it. */
  exportId?: string;
  /** True when this export began by downloading Chromium (first canvas
   *  export on this machine) — so the agent can explain the extra time. */
  chromiumDownloaded?: boolean;
  /** Overlays a chromium-render export went out without. The export still
   *  succeeded; absent when nothing was dropped. Two kinds of entry:
   *  - a body overlay whose draw threw (QA 2026-09-18 B1 — e.g. a code
   *    overlay with no/invalid body): `message` is text the BODY produced,
   *    bounded and marked `messageSource: "overlay body (untrusted)"`, like
   *    `renderDiagnostics` — offer to fix its draw function;
   *  - a video clip that could not be loaded (F13): `kind: "video"`, its
   *    `fileId`, and libi's own `message` (`messageSource: "libi"`) — the
   *    clip is missing from the file; check / replace it. */
  droppedOverlays?: FramedDroppedOverlay[];
  /** Uploaded fonts a chromium-render export could not load (Final QA F1):
   *  their text rendered in a fallback face. The export still succeeded; tell
   *  the user which font and why. Absent when every font loaded. */
  unloadedFonts?: Array<{ fontFileId: string; family: string; reason: string }>;
  /** Set when text/code/3D raised the frame above the requested `quality`
   *  because `graphicsQuality` was left at its default (EXP-4) — e.g. a
   *  `quality: "1080p"` export of a piece with captions coming out 3840×2160.
   *  Relay it to the user. Absent otherwise. */
  note?: string;
  /** Which copyrighted audio the file carries. */
  audioDecision?: AudioDecision;
}

interface ExportEnqueueResp {
  jobId: string;
  exportId: string;
  name: string;
  /** Set by the route when Chromium is absent: the approximate size of the
   *  download this export may start with. Null once it is installed. */
  chromiumDownloadMb?: number | null;
  settings: {
    format: "mp4" | "webm";
    width: number;
    height: number;
    bitrate: number;
    quality: string;
    graphicsQuality?: string;
    /** Which tier set the frame ("graphics" = text/code/3D raised it). */
    drivenBy?: "media" | "graphics";
    /** True when the request named no graphicsQuality (the default was used). */
    graphicsQualityDefaulted?: boolean;
  };
}

const GRAPHICS_TIER_LABEL: Record<string, string> = { "4k": "4K", "1440p": "1440p" };

/**
 * The result note for an export whose frame the graphics tier raised above
 * `quality` (0.1.15's quality split: `graphicsQuality` defaults to 4K, and an
 * export is one frame, so `quality: "1080p"` with captions comes out 4K). Kept
 * as behaviour — it is a product decision — but said, so a 1080p request that
 * arrives as a 3840×2160 file is not a surprise. Only when the default was
 * used: an explicit graphicsQuality is the agent's own choice.
 */
export function graphicsRaisedNote(
  settings: ExportEnqueueResp["settings"] | undefined,
  out: { width: number; height: number },
): string | undefined {
  if (!settings || settings.drivenBy !== "graphics" || !settings.graphicsQualityDefaulted) return undefined;
  const tier = GRAPHICS_TIER_LABEL[settings.graphicsQuality ?? ""];
  if (!tier) return undefined;
  return (
    `Exported at ${out.width}×${out.height}: text/code/3D default to ${tier}. ` +
    `Pass graphicsQuality: "1080p" to cap them.`
  );
}

/**
 * Triggers an export via the unified `export` JobManager runner. Two-phase:
 * the route enqueues the job (returning the runner-resolved settings +
 * jobId), then we attach to it via SSE through `runJobViaServer` so
 * progress notifications flow to the chat UI on the original toolCallId.
 */
export async function exportVideo(
  params: ExportVideoParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  | { success: true; data: ExportVideoResult }
  | {
      success: false;
      error?: string;
      data?: { error: string; hint?: string };
    }
> {
  if (params.destFolder !== undefined) {
    return { success: false, data: { error: "dest_folder_removed", hint: DEST_FOLDER_REFUSAL } };
  }

  let port: number;
  try {
    port = getCurrentPort();
  } catch (err) {
    return {
      success: false,
      data: {
        error: "libi_server_unavailable",
        hint: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // First: POST the export request so the server validates + enqueues. We
  // don't use runJobViaServer's own enqueue path because the server route
  // resolves the quality preset → concrete settings — duplicating that
  // logic on the MCP side is brittle.
  let enq: ExportEnqueueResp;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 422) {
        try {
          const j = JSON.parse(text) as { error?: string; message?: string };
          if (j.error === "purpose_required") return { success: false, data: { error: "purpose_required", hint: j.message ?? text } };
        } catch {
          // fall through to the generic answer
        }
      }
      return { success: false, data: { error: `export_enqueue_failed_${resp.status}`, hint: text } };
    }
    enq = (await resp.json()) as ExportEnqueueResp;
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        data: { error: "libi_server_unavailable", hint: err.hint },
      };
    }
    return {
      success: false,
      data: {
        error: "export_enqueue_failed",
        hint: err instanceof Error ? err.message : String(err),
      },
    };
  }

  logger.info(
    {
      tag: "export-tool",
      op: "enqueued",
      jobId: enq.jobId,
      exportId: enq.exportId,
      pieceId: params.pieceId,
    },
    "export_video: job enqueued, waiting for completion",
  );

  // Disclose the cost BEFORE the wait begins. `waitForJobCompletion` blocks
  // until the job ends, so anything said afterwards is said too late.
  // Also rides the job_progress side channel so Claude's chat row shows it.
  if (enq.chromiumDownloadMb) {
    await reportToolProgress(extra, {
      progress: 0,
      total: enq.chromiumDownloadMb,
      message: `first canvas export downloads Chromium, ~${enq.chromiumDownloadMb} MB`,
    });
  }

  // Now attach to the running job so we forward progress. We don't re-enqueue
  // (forceNew would create a second job); instead we use runJobViaServer's
  // attach path by sending the same params again with `attachIfExists` — but
  // the simpler approach: just open the SSE stream ourselves and forward.
  //
  // For now: re-call runJobViaServer with `attachToJobId` is not available;
  // we POST a tracking-only attach via the existing SSE path on the jobId.
  // The jobs-client's `runJobViaServer` requires kind+params; instead we
  // open the events stream directly here.
  const result = await waitForJobCompletion(port, enq.jobId, extra, enq.exportId);
  if (!result.ok) {
    return {
      success: false,
      data: { error: result.error, hint: result.hint },
    };
  }

  const { droppedOverlays, ...value } = result.value;
  const note = graphicsRaisedNote(enq.settings, value);
  return {
    success: true,
    data: {
      ...value,
      ...(droppedOverlays?.length ? { droppedOverlays: droppedOverlays.map(frameDroppedOverlay) } : {}),
      ...(note ? { note } : {}),
      jobId: enq.jobId,
      exportId: enq.exportId,
      chromiumDownloaded: Boolean(enq.chromiumDownloadMb),
    },
  };
}

async function waitForJobCompletion(
  port: number,
  jobId: string,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  exportId?: string,
): Promise<
  | { ok: true; value: Omit<ExportVideoResult, "jobId"> }
  | { ok: false; error: string; hint?: string }
> {
  // Use the progress-token from the MCP extra if present so claude-agent-acp
  // routes notifications to the same toolCallId.
  const progressToken = extra?._meta?.progressToken as string | number | undefined;

  // The WHY of a wait lives on the export's record; re-read it at most every 5 s.
  let waitLine = EXPORT_WAITING_MESSAGE;
  let waitReadAt = 0;
  const waitingText = async (): Promise<string> => {
    if (!exportId || Date.now() - waitReadAt < 5000) return waitLine;
    waitReadAt = Date.now();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/exports/${encodeURIComponent(exportId)}`);
      if (r.ok) {
        const body = (await r.json()) as { export?: { waiting?: { message?: string } | null } };
        waitLine = body.export?.waiting?.message ?? EXPORT_WAITING_MESSAGE;
      }
    } catch {
      // Keep the last line.
    }
    return waitLine;
  };

  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
  } catch (err) {
    return {
      ok: false,
      error: "export_stream_failed",
      hint: err instanceof Error ? err.message : String(err),
    };
  }
  if (!resp.ok || !resp.body) {
    return { ok: false, error: `export_stream_${resp.status}` };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n\n");
      while (nl !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        nl = buf.indexOf("\n\n");
        if (!frame.trim()) continue;
        // Parse "event: <type>\ndata: <json>" SSE blocks.
        let eventType = "message";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload: { jobId?: string; done?: number; total?: number; unit?: string; result?: unknown; error?: string };
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (eventType === "progress" && progressToken !== undefined && extra?.sendNotification) {
          const done = typeof payload.done === "number" ? payload.done : 0;
          const total = typeof payload.total === "number" && payload.total > 0 ? payload.total : 1;
          const unit = payload.unit ?? "";
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: done,
              total,
              message: isExportWaiting(payload) ? await waitingText() : unit ? `${done}/${total} ${unit}` : `${done}/${total}`,
            },
          }).catch(() => { /* ignore */ });
          continue;
        }
        if (eventType === "completed") {
          const r = payload.result as Omit<ExportVideoResult, "jobId"> | undefined;
          if (!r) {
            return { ok: false, error: "export_completed_without_result" };
          }
          return { ok: true, value: r };
        }
        if (eventType === "failed") {
          return { ok: false, error: "export_failed", hint: payload.error };
        }
        if (eventType === "cancelled") {
          return { ok: false, error: "export_cancelled" };
        }
      }
    }
    return { ok: false, error: "export_stream_ended_without_result" };
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/**
 * `libi.export_video` with `variants` (spec 2026-09-29 §B3): enqueue every
 * export through `/api/export` and return at once — the scheduler runs them
 * in parallel, and `libi.list_exports` reports them. A refusal stops the batch
 * and says what was already queued.
 */
export async function exportVideoVariants(
  params: ExportVideoParams,
): Promise<
  | { success: true; data: { queued: QueuedExportVariant[]; note: string } }
  | { success: false; data: { error: string; hint?: string; queued: QueuedExportVariant[]; note?: string; failedIndex?: number } }
> {
  const queued: QueuedExportVariant[] = [];
  if (params.destFolder !== undefined) {
    return { success: false, data: { error: "dest_folder_removed", hint: DEST_FOLDER_REFUSAL, queued } };
  }
  let port: number;
  try {
    port = getCurrentPort();
  } catch (err) {
    return { success: false, data: { error: "libi_server_unavailable", hint: err instanceof Error ? err.message : String(err), queued } };
  }
  const { variants = [], ...shared } = params;
  /** When the batch stops part-way, say what already runs: a retry of the whole call would render those twice. */
  const stoppedAt = (index: number): { note?: string; failedIndex?: number } =>
    queued.length === 0
      ? {}
      : {
          note: `${queued.length} of ${variants.length} exports were queued and are still rendering — retry only the remaining variants (from index ${index}), not the whole call.`,
          failedIndex: index,
        };
  for (const [index, variant] of variants.entries()) {
    const body = {
      pieceId: shared.pieceId,
      source: shared.source,
      format: shared.format,
      quality: shared.quality,
      graphicsQuality: shared.graphicsQuality,
      purpose: shared.purpose,
      copyrightedAudio: shared.copyrightedAudio,
      includeFileIds: shared.includeFileIds,
      ...variant,
      batchSize: variants.length,
    };
    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${port}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { success: false, data: { error: "export_enqueue_failed", hint: err instanceof Error ? err.message : String(err), queued, ...stoppedAt(index) } };
    }
    if (!resp.ok) {
      const text = await resp.text();
      let error = `export_enqueue_failed_${resp.status}`;
      let hint = text;
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        if (j.error === "purpose_required") error = "purpose_required";
        hint = j.message ?? j.error ?? text;
      } catch {
        // not JSON — the raw text is the hint
      }
      return { success: false, data: { error, hint, queued, ...stoppedAt(index) } };
    }
    const enq = (await resp.json()) as ExportEnqueueResp;
    queued.push({ exportId: enq.exportId, name: enq.name, format: enq.settings.format, width: enq.settings.width, height: enq.settings.height });
  }
  logger.info({ tag: "export-tool", op: "variants_queued", pieceId: params.pieceId, count: queued.length }, "export_video: variants queued");
  return { success: true, data: { queued, note: VARIANTS_NOTE } };
}
