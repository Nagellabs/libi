import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { z } from "zod/v3";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { loadComposition } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { classifyExportShape } from "@/lib/export/classifier";
import { resolveExportBase } from "@/lib/export/export-base";
import { stripHiddenLayerArrays } from "@/lib/overlays/hidden";
import { attachOverlaySourceDims } from "@/lib/export/source-dims";
import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";
import { FfmpegOverlayBackend, overlayGraphNeedsBrowser } from "@/lib/export/backends/ffmpeg-overlay";
import { ChromiumRenderBackend } from "@/lib/export/backends/chromium-render";
import { resolveExportFolder } from "@/lib/db/settings";
import { ensureFolderExists } from "@/lib/export/folder";
import { claimExportPath } from "@/lib/export/filename";
import { ensureChromium } from "@/lib/export/ensure-chromium";
import { getDb } from "@/lib/db/client";
import { files as filesTable, pieces } from "@/lib/db/schema";
import type { RenderPayload } from "@/lib/export/render-jobs";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import type {
  AudioClip,
  Composition,
  ExportSettings,
  Overlay,
} from "@/lib/engine/types";
import { exportLogger } from "@/lib/logger";
import { cssFamilyForFontFile } from "@/lib/fonts/family";

/**
 * Unified `export` job. One entry point covers all three server-side backends
 * (stream-copy-trim, ffmpeg-overlay, chromium-render) so the UI + chat + MCP
 * surface get one progress stream and one cancel handle.
 *
 * Output is written DIRECTLY to the configured export folder under the
 * resolved filename — there's no browser-download round-trip.
 *
 * Cancellation: the runner forwards JobManager's AbortSignal to the
 * underlying backend. The ffmpeg helper SIGKILLs its child on abort and
 * unlinks the partial output; the chromium-render backend cancels its
 * inner JobManager job which tears down the headless page.
 *
 * Re-classification: when the picked quality changes target dimensions
 * (e.g. user requests 4K from a 1080p source), `stream-copy-trim` cannot
 * change resolution with `-c copy` — we override the classifier and use
 * `ffmpeg-overlay` so the upscale stage runs.
 */

const exportParamsSchema = z.object({
  pieceId: z.string().min(1),
  source: z.enum(["draft", "snapshot"]).default("draft"),
  filename: z.string().min(1),
  settings: z
    .object({
      format: z.enum(["mp4", "webm"]),
      // `codec` is server-derived from `format`, never user-controlled. It's
      // kept here so chromium-render + canvas-source backends still see a
      // concrete value, but ANY caller-supplied codec is overwritten in the
      // /api/export route to match the format. The validator accepts it so
      // existing test rigs that pass it through don't break.
      codec: z.enum(["avc", "vp9", "av1"]),
      bitrate: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().int().positive(),
      quality: z.enum(["source", "1080p", "1440p", "4k", "custom"]).optional(),
      graphicsQuality: z.enum(["1080p", "1440p", "4k"]).optional(),
      audioBitrate: z.number().int().positive().optional(),
    })
    .passthrough(),
  /** Absolute folder to write to. Empty/missing = use the configured default. */
  destFolder: z.string().optional(),
});

export type ExportParams = z.infer<typeof exportParamsSchema>;

export interface ExportResult {
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  backend: "stream-copy-trim" | "ffmpeg-overlay" | "chromium-render";
  width: number;
  height: number;
  /** Overlays whose draw threw during the chromium-render pass and were
   *  skipped (QA 2026-09-18 B1) — surfaced here so `libi.export_video`'s
   *  response tells the agent which overlay(s) failed. The export still
   *  succeeds; this is informational. Only the chromium-render backend can
   *  produce this (stream-copy-trim / ffmpeg-overlay never run a code
   *  overlay's draw function). */
  droppedOverlays?: Array<{ id: string; message: string }>;
  /** Uploaded fonts the chromium-render page could not load (Final QA F1):
   *  their text rendered in a fallback face. The export still succeeds; the
   *  agent tells the user which font and why. Bounded; absent when every
   *  font loaded. `family` is the one libi.upload_font returned. */
  unloadedFonts?: Array<{ fontFileId: string; family: string; reason: string }>;
}

/** Cap on the reported unloaded-fonts list. */
const MAX_UNLOADED_FONTS = 20;

export const exportRunner: JobRunner<ExportParams, ExportResult> = {
  kind: "export",
  // Single-slot. On macOS, h264_videotoolbox is a single-session encoder on
  // older models; two parallel exports will silently serialize at the kernel
  // level or fail one with "Error while opening encoder". libx264 with
  // -preset slow also saturates CPU and starves the rest of the app
  // (chat agent, preview rendering). Users who want a second variant can
  // queue it — JobManager dispatches the next on completion.
  maxConcurrent: 1,
  paramsSchema: exportParamsSchema as unknown as z.ZodSchema<ExportParams>,
  resumable: false,
  // ffmpeg + chromium may go silent for stretches; the surrounding backends
  // have their own internal timeouts (5min for chromium driver).
  noProgressTimeoutMs: null,
  // Surface to chat via libi.export_video — the bridge derives the kind→toolId
  // map from this declaration.
  mcpToolId: makeMcpToolId("libi", "libi.export_video"),
  async run(ctx: JobContext<ExportParams>): Promise<ExportResult> {
    const { pieceId, source, filename, settings } = ctx.params;
    const destFolder = ctx.params.destFolder?.trim() || resolveExportFolder();

    // Validate / create the destination folder up front so we fail fast.
    try {
      ensureFolderExists(destFolder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Export folder not writable: ${destFolder} (${msg})`);
    }

    // Load composition (draft or snapshot).
    let manifest: CompositionManifest;
    if (source === "snapshot") {
      const snap = await loadCurrentSnapshot(pieceId);
      if (!snap) throw new Error(`No committed snapshot for piece ${pieceId}`);
      manifest = snap;
    } else {
      ({ manifest } = await loadComposition(pieceId));
    }

    // Hidden layers (overlay.hidden — the persisted eye toggle) leave the
    // export entirely: strip them + their coupled inline audio ONCE, before
    // classification — every downstream consumer (classifier, all three
    // backends, the chromium render payload + its audio mux) reads the
    // filtered arrays. This is what makes agent/server exports honor the eye
    // with no client threading.
    const stripped = stripHiddenLayerArrays(manifest.overlays, manifest.audioClips);
    if (stripped.changed) {
      manifest = { ...manifest, overlays: stripped.overlays, audioClips: stripped.audioClips };
    }

    const composition = buildCompositionFromManifest(manifest);

    // Resolve the actual ExportSettings shape — derive width/height from the
    // composition for "source" preset. The route should have already done
    // this, but keep it defensive.
    const resolvedSettings: ExportSettings = {
      ...settings,
      width: settings.width || manifest.width,
      height: settings.height || manifest.height,
      fps: settings.fps || manifest.fps,
    };

    let shape = classifyExportShape(composition).tag;
    if (shape === "canvas-source") shape = "chromium-render"; // browser-only — not reachable from server runner
    if (shape === "error") throw new Error("Composition cannot be exported");

    // If target dims differ from composition AND the classifier picked
    // stream-copy-trim, upgrade to ffmpeg-overlay so the upscale stage runs.
    if (
      shape === "stream-copy-trim" &&
      (resolvedSettings.width !== composition.width || resolvedSettings.height !== composition.height)
    ) {
      shape = "ffmpeg-overlay";
    }

    // stream-copy-trim only ships the source bytes verbatim. If the requested
    // container ≠ what the source actually contains, the output file would be
    // bytes of one codec wrapped in a different container's box layout (an
    // H.264-in-WebM file most players refuse). Force ffmpeg-overlay to
    // transcode whenever the target format isn't MP4, or when the source
    // file extension hints at a different container than MP4.
    if (shape === "stream-copy-trim") {
      // The stream-copy base is always the bottom full-frame video OVERLAY —
      // resolved by the same shared resolver the classifier used to pick this
      // shape, so the two can't disagree about which file ships.
      const base = resolveExportBase(composition);
      const sourceFile = base
        ? getDb().select().from(filesTable).where(eq(filesTable.id, base.fileId)).limit(1).all()[0]
        : null;
      const sourceExt = sourceFile?.filename.split(".").pop()?.toLowerCase() ?? "";
      const mp4Family = sourceExt === "mp4" || sourceExt === "m4v" || sourceExt === "mov";
      if (resolvedSettings.format !== "mp4" || !mp4Family) {
        shape = "ffmpeg-overlay";
      }
    }

    // An ffmpeg too old to read its graph from a file would take a
    // caption-heavy graph on the command line, past what the OS accepts —
    // render those in the browser instead.
    if (shape === "ffmpeg-overlay" && (await overlayGraphNeedsBrowser(composition, resolvedSettings))) {
      exportLogger.info(
        { op: "graph_too_long_inline", jobId: ctx.jobId, pieceId },
        "export.fallback — overlay graph too long for this ffmpeg's command line",
      );
      shape = "chromium-render";
    }

    // ── Step `ensure-chromium` ────────────────────────────────────────────
    // The classifier is pure — the `fallbackShape()` sites in
    // lib/export/classifier.ts know an export needs a browser but cannot
    // fetch one. This is the first impure place that knows `shape`, and it is
    // deliberately BEFORE `claimExportPath` so a failed or cancelled download
    // leaves no placeholder file behind.
    //
    // Progress is reported in MB, not on the 0..100 "%" scale the render uses
    // below. The unit travels with each event (JobManager stores
    // `progressUnit` per row; the agent-facing string is built from it in
    // mcp/tools/export-tools.ts), so the chat reads "87/173 MB" during the
    // download and "12/100 %" during the render — two honest phases rather
    // than one bar that restarts. Every MB tick comes from the download
    // itself: an export on a machine that already has Chromium must not
    // flash a "0/173 MB" bar (it did, until a review caught it).
    //
    // Wire the AbortSignal here, before the download, rather than at the
    // render: JobManager cancels via ctx.shouldCancel, and the signal gives
    // the download (and later ffmpeg + chromium) a SIGKILL/teardown on cancel
    // without waiting for the poll. ONE `finally` owns the interval from
    // here to the end of the run — every exit path clears it, including a
    // throw from `claimExportPath` between the download and the render,
    // which used to leak a poll that outlived the failed job.
    const ac = new AbortController();
    const cancelPoll = setInterval(() => {
      if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
    }, 500);

    try {
      if (shape === "chromium-render") {
        await ensureChromium({
          shouldCancel: () => ctx.shouldCancel(),
          signal: ac.signal,
          onProgress: ({ doneMb, totalMb }) => {
            ctx.reportProgress(doneMb, totalMb, "MB");
          },
        });
        // Nothing about a completed download is resumable — the Playwright CLI
        // owns its own partial state under ms-playwright — but the checkpoint
        // records that this phase is behind us, so a resumed job's status page
        // does not re-advertise a download that already happened.
        await ctx.checkpoint({ chromiumReady: true });
        if (ctx.shouldCancel()) throw new Error("cancelled");
      }

      // Claim the destination path atomically.
      const ext = resolvedSettings.format;
      const outputPath = claimExportPath(destFolder, filename, ext);

      exportLogger.info(
        {
          event: "start",
          jobId: ctx.jobId,
          backend: shape,
          pieceId,
          source,
          outputPath,
          targetWidth: resolvedSettings.width,
          targetHeight: resolvedSettings.height,
          bitrate: resolvedSettings.bitrate,
        },
        "export.start",
      );

      // Progress is reported as a percentage on a fixed 0..100 scale. The
      // underlying ffmpeg-overlay / stream-copy backends compute the ratio
      // against their OWN duration math (which is the trimmed window, not the
      // composition total) — keeping the runner's denominator fixed at 100
      // means the bar moves monotonically and ends exactly at 100% no matter
      // which backend ran.
      ctx.reportProgress(0, 100, "%");

      const onProgress = (ratio: number) => {
        const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        ctx.reportProgress(pct, 100, "%");
      };

      try {
        let durationSeconds = 0;
        let droppedOverlays: Array<{ id: string; message: string }> | undefined;
        let unloadedFonts: ExportResult["unloadedFonts"];

        if (shape === "stream-copy-trim") {
          const backend = new StreamCopyTrimBackend();
          const result = await backend.run({
            composition,
            settings: resolvedSettings,
            outputPath,
            onProgress,
            signal: ac.signal,
          });
          durationSeconds = result.duration;
        } else if (shape === "ffmpeg-overlay") {
          const backend = new FfmpegOverlayBackend();
          const result = await backend.run({
            composition,
            settings: resolvedSettings,
            outputPath,
            onProgress,
            signal: ac.signal,
          });
          durationSeconds = result.duration;
        } else {
          // chromium-render path: build the payload, run the existing backend
          // (which delegates to the export_render runner via JobManager), then
          // MOVE the temp file to outputPath.
          const payload = buildRenderPayload(pieceId, manifest);
          const backend = new ChromiumRenderBackend();
          const result = await backend.run({
            pieceId,
            composition,
            payload,
            settings: resolvedSettings,
            onProgress,
            signal: ac.signal,
          });
          durationSeconds = result.duration;
          droppedOverlays = result.droppedOverlays;
          // Make a dropped overlay findable beyond the render page's own
          // console line, keyed by the job id the agent was given (QA
          // 2026-09-18 B1, O1).
          if (droppedOverlays?.length) {
            exportLogger.warn(
              { op: "overlay_dropped", jobId: ctx.jobId, pieceId, droppedOverlays },
              "export.overlay_dropped",
            );
          }
          // An uploaded font the render page couldn't load drew in a default
          // face (QA 2026-09-18 recheck N5). Not fatal, but never silent.
          if (result.unloadedFonts?.length) {
            unloadedFonts = result.unloadedFonts.slice(0, MAX_UNLOADED_FONTS).map((f) => ({
              fontFileId: f.fontFileId,
              family: cssFamilyForFontFile(f.fontFileId),
              reason: f.reason,
            }));
            exportLogger.warn(
              { op: "font_load_failed", jobId: ctx.jobId, pieceId, unloadedFonts },
              "export.font_load_failed",
            );
          }
          // The chromium backend returned a Blob; write it to our claimed path.
          const buf = Buffer.from(await result.blob.arrayBuffer());
          await fs.writeFile(outputPath, new Uint8Array(buf));
        }

        const stat = await fs.stat(outputPath);
        // Snap to 100% on success so the bar lands exactly full, regardless of
        // whether the backend stopped reporting at 99%.
        ctx.reportProgress(100, 100, "%");
        exportLogger.info(
          {
            event: "done",
            jobId: ctx.jobId,
            backend: shape,
            pieceId,
            outputPath,
            sizeBytes: stat.size,
            durationSeconds,
          },
          "export.done",
        );
        return {
          filePath: outputPath,
          sizeBytes: stat.size,
          durationSeconds,
          backend: shape as ExportResult["backend"],
          width: resolvedSettings.width,
          height: resolvedSettings.height,
          ...(droppedOverlays?.length ? { droppedOverlays } : {}),
          ...(unloadedFonts?.length ? { unloadedFonts } : {}),
        };
      } catch (err) {
        // Clean up the claimed placeholder/partial file.
        try { fsSync.unlinkSync(outputPath); } catch { /* ignore */ }
        const message = err instanceof Error ? err.message : String(err);
        const isCancel = ctx.shouldCancel() || ac.signal.aborted;
        exportLogger.warn(
          {
            event: isCancel ? "cancel" : "fail",
            jobId: ctx.jobId,
            backend: shape,
            pieceId,
            outputPath,
            error: message,
            // ffmpeg-overlay keeps a failed long graph's file for debugging.
            ...graphFileOf(err),
          },
          `export.${isCancel ? "cancel" : "fail"}`,
        );
        throw err;
      }
    } finally {
      clearInterval(cancelPoll);
    }
  },
};

function buildCompositionFromManifest(
  manifest: CompositionManifest,
): Composition {
  return {
    id: "composition-1",
    name: "Export",
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    // Source dims for video overlays — the classifier reads them to decide
    // whether `-c copy` would preserve the composition's framing.
    overlays: attachOverlaySourceDims((manifest.overlays ?? []) as Overlay[]),
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
  };
}

function buildRenderPayload(
  pieceId: string,
  manifest: CompositionManifest,
): RenderPayload {
  const db = getDb();
  const files = db.select().from(filesTable).where(eq(filesTable.pieceId, pieceId)).all();
  return {
    overlays: (manifest.overlays ?? []) as Overlay[],
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    files,
  };
}

/** Look up the piece's `name` for default-filename derivation. */
export function getPieceName(pieceId: string): string | null {
  const db = getDb();
  const [row] = db.select({ name: pieces.name }).from(pieces).where(eq(pieces.id, pieceId)).limit(1).all();
  return row?.name ?? null;
}

/** Resolve the default OS temp dir for ad-hoc paths. Convenience export. */
export function tempExportDir(): string {
  return os.tmpdir();
}

/** The filter-graph file a failed ffmpeg-overlay run kept, if any. */
function graphFileOf(err: unknown): { graphFile?: string } {
  const graphFile = (err as { graphFile?: unknown } | null)?.graphFile;
  return typeof graphFile === "string" ? { graphFile } : {};
}
