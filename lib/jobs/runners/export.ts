import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod/v3";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { detectAvailableEncoders, pickEncoder } from "@/lib/export/hw-accel";
import { estimateCost, type CostEstimate } from "@/lib/export/cost";
import { resolveChunkWorkers } from "@/lib/export/chunk-plan";
import type { ExportPriority } from "@/lib/export/admission";
import { getExportScheduler, isHwEncoderSessionError, HW_SESSION_FAILED_MESSAGE, type Reservation } from "@/lib/export/scheduler";
import type { ExportWaiting } from "@/lib/exports/types";
import { EXPORT_WAITING_UNIT } from "@/lib/export/export-waiting";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { loadComposition } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { classifyExportShape } from "@/lib/export/classifier";
import { resolveExportBase } from "@/lib/export/export-base";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { attachOverlaySourceDims } from "@/lib/export/source-dims";
import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";
import { FfmpegOverlayBackend, overlayGraphNeedsBrowser } from "@/lib/export/backends/ffmpeg-overlay";
import { ChromiumRenderBackend } from "@/lib/export/backends/chromium-render";
import { claimExportFile } from "@/lib/export/filename";
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
import { exportLogger, serverLogger as logger } from "@/lib/logger";
import { cssFamilyForFontFile } from "@/lib/fonts/family";
import { describeDroppedOverlays, droppedVideoFileIds, type DroppedOverlay } from "@/lib/export/dropped-overlays";
import { applyAudioExclusion, purposeRequiredMessage, resolveExportAudio, type AudioDecision } from "@/lib/export/audio-policy";
import { filesForManifest } from "@/lib/audio-rights/piece-reader";
import { pieceAudioOf } from "@/lib/audio-rights/piece-audio";
import {
  createExportRecord,
  getExportRecord,
  markExportCancelled,
  markExportDone,
  markExportFailed,
  markExportRunning,
  setExportFile,
  uniqueExportName,
} from "@/lib/exports/store";
import { exportsDirFor, fileStem, relPathFor } from "@/lib/exports/paths";

/**
 * Unified `export` job. One entry point covers all three server-side backends
 * (stream-copy-trim, ffmpeg-overlay, chromium-render) so the UI + chat + MCP
 * surface get one progress stream and one cancel handle.
 *
 * Output is written DIRECTLY to the piece's exports folder
 * (`<storage>/<pieceId>/exports/`, lib/exports/paths.ts), and the export's
 * `piece_exports` record (lib/exports/store.ts) follows it: running, file
 * claimed, done / failed / cancelled. No browser-download round-trip.
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
      purpose: z.enum(["social", "personal"]).optional(),
      copyrightedAudio: z.enum(["exclude", "include"]).optional(),
      includeFileIds: z.array(z.string()).optional(),
      excludeFileIds: z.array(z.string()).optional(),
    })
    .passthrough(),
  /** The `piece_exports` row this job fills (lib/exports/store.ts). One per
   *  export, so it also keeps two same-settings exports from sharing a
   *  paramsHash: `forceNew` never deletes another export's job row. Absent on a
   *  job enqueued some other way (`POST /api/jobs`) — the runner then creates
   *  the record itself. An old queued job's `destFolder` is stripped by zod. */
  exportId: z.string().min(1).optional(),
});

export type ExportParams = z.infer<typeof exportParamsSchema>;

export interface ExportResult {
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  backend: "stream-copy-trim" | "ffmpeg-overlay" | "chromium-render";
  width: number;
  height: number;
  /** Overlays the chromium-render pass went out without: a body whose draw
   *  threw (QA 2026-09-18 B1), or a video clip that could not be loaded (F13).
   *  Surfaced so `libi.export_video`'s response tells the agent, and the
   *  export screen tells the user. The export still succeeds; this is
   *  informational. A video entry carries `kind: "video"` + its file
   *  (`lib/export/dropped-overlays.ts`). Only the chromium-render backend can
   *  produce this (stream-copy-trim / ffmpeg-overlay run no draw function and
   *  read the original through ffmpeg, which fails the export instead). */
  droppedOverlays?: DroppedOverlay[];
  /** Uploaded fonts the chromium-render page could not load (Final QA F1):
   *  their text rendered in a fallback face. The export still succeeds; the
   *  agent tells the user which font and why. Bounded; absent when every
   *  font loaded. `family` is the one libi.upload_font returned. */
  unloadedFonts?: Array<{ fontFileId: string; family: string; reason: string }>;
  /** Which copyrighted audio this file carries (spec §5.1). `latestExportFor`
   *  (mcp/tools/social-tools.ts) and the Posting tab reuse an export only when
   *  it matches what the post needs. Required: a result without it must not
   *  compile, because the record would read as song-free. */
  audioDecision: AudioDecision;
}

/** Cap on the reported unloaded-fonts list. */
const MAX_UNLOADED_FONTS = 20;

export const exportRunner: JobRunner<ExportParams, ExportResult> = {
  kind: "export",
  // Not a limit: the export scheduler (lib/export/scheduler.ts) decides how
  // many exports run at once from each one's cost, the free memory, the CPU
  // load and the hardware encoder's session cap (plan task B0). A job slot
  // here would only hide an export from the scheduler's queue.
  maxConcurrent: 32,
  paramsSchema: exportParamsSchema as unknown as z.ZodSchema<ExportParams>,
  resumable: false,
  // ffmpeg + chromium may go silent for stretches; the surrounding backends
  // have their own internal timeouts (5min for chromium driver).
  noProgressTimeoutMs: null,
  // Surface to chat via libi.export_video — the bridge derives the kind→toolId
  // map from this declaration.
  mcpToolId: makeMcpToolId("libi", "libi.export_video"),
  async run(ctx: JobContext<ExportParams>): Promise<ExportResult> {
    const exportId = await ensureExportRecord(ctx);
    // The file this run claimed, and who it was when claimed (see `FileClaim`).
    const held: { claim: FileClaim | null } = { claim: null };
    try {
      const result = await renderRecorded(ctx, exportId, (c) => {
        held.claim = c;
      });
      // Deleted while it rendered: the user wanted it gone — the file too, but only
      // OUR file: the name was free the moment the row went, and another export may
      // already own the path.
      if (!markExportDone(exportId, result)) removeClaimedFile(held.claim);
      return result;
    } catch (err) {
      // Normally the render's own catch removed the file already; this covers a throw
      // after a successful render (a refused done write). Release the claim either way.
      removeClaimedFile(held.claim);
      if (err instanceof CancelledError || ctx.shouldCancel()) markExportCancelled(exportId);
      else markExportFailed(exportId, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      // The claim stayed open through every cleanup above; only now may its inode be reused.
      held.claim?.release();
    }
  },
};

/** An export whose record is gone never writes a file. */
export const EXPORT_DELETED_MESSAGE = "This export was deleted before it finished.";

/**
 * The record this job fills: the one `/api/export` created, or a new one for
 * a job enqueued without it. Controller amendment (preflight-scan Minor #5):
 * an `exportId` is only ever honored for THIS job's own piece and while it is
 * still queued/failed — a job enqueued via `POST /api/jobs` with another
 * piece's exportId (or one already claimed by a different run) must not fill
 * that record; its file would land in the wrong piece's folder while
 * `relPath` still resolves under the other one.
 */
async function ensureExportRecord(ctx: JobContext<ExportParams>): Promise<string> {
  const { exportId, pieceId, filename, settings } = ctx.params;
  if (exportId) {
    const record = getExportRecord(exportId);
    if (!record || record.pieceId !== pieceId || (record.status !== "queued" && record.status !== "failed")) {
      throw new Error(EXPORT_DELETED_MESSAGE);
    }
    return exportId;
  }
  const name = await uniqueExportName(pieceId, filename, settings.format);
  return createExportRecord({
    pieceId,
    name,
    jobId: ctx.jobId,
    source: "agent",
    settings: {
      format: settings.format,
      codec: settings.codec,
      fps: settings.fps,
      width: settings.width,
      height: settings.height,
      quality: settings.quality ?? null,
      graphicsQuality: settings.graphicsQuality ?? null,
      purpose: settings.purpose ?? null,
    },
  }).id;
}

/** Render into the record's file, admitted by the export scheduler in the foreground. */
async function renderRecorded(ctx: JobContext<ExportParams>, exportId: string, onClaimed: (claim: FileClaim) => void): Promise<ExportResult> {
  if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
  return renderExport(ctx, { kind: "record", exportId }, {
    onClaimed,
    priority: "foreground",
    schedulerId: exportId,
    // Waiting its turn: say so, rather than sit at "running 0 %" (final review F7).
    onWait: () => ctx.reportProgress(0, 1, EXPORT_WAITING_UNIT),
    onAdmitted: () => markExportRunning(exportId, ctx.jobId),
  });
}

/** Where an export's file goes. */
export type ExportTarget =
  /** A user/agent export: the piece's exports folder, named by its record. */
  | { kind: "record"; exportId: string }
  /** A template example render: a work folder its caller owns. No record. */
  | { kind: "dir"; dir: string };

/**
 * The export itself: the piece rendered into `target` by the backend the
 * classifier picks, reading ORIGINAL media. The `export` job runs it (above);
 * so does a template's example render (lib/templates/example-export.ts), in
 * its own job and under its own scheduler slot, so that no `export` row — the
 * Posting tab's "latest export", `libi.post_piece`'s, the jobs list's — is
 * ever recorded for it. It is admitted by the export scheduler
 * (lib/export/scheduler.ts) once it knows its backend, unless the caller
 * already holds a slot (`opts.reservation`).
 */

/** How a render is admitted (lib/export/scheduler.ts). */
export interface RenderExportOptions {
  /** A slot the caller already holds — a background example render. Skips admission. */
  reservation?: Reservation;
  /** Default "foreground". */
  priority?: ExportPriority;
  /** Names the render in the scheduler's logs; defaults to the record's id, else the job id. */
  schedulerId?: string;
  onWait?: (waiting: ExportWaiting) => void;
  /** Called once admitted, before the file is claimed. */
  onAdmitted?: () => void;
  /**
   * Called with the file this render claimed, right after the claim. Giving it
   * hands the claim to the caller: the render leaves the claim's descriptor
   * open and the caller must `release()` it once its own cleanup is done.
   * Without it the render releases the claim itself when it ends.
   */
  onClaimed?: (claim: FileClaim) => void;
}

/**
 * The file a render claimed, and which file that was. A path is not an
 * identity — a cancelled or deleted export frees its name at once, and the
 * next export of the same name claims the same path while the old runner is
 * still tearing down. The old runner must then leave that file alone, so every
 * removal of "its" file goes through `removeClaimedFile`, which unlinks only
 * when the path still names this file.
 *
 * Identity is device + inode, and it is sound because the claim keeps the
 * placeholder's descriptor OPEN from the `wx` create until `release()`: an
 * open descriptor keeps the inode allocated, so no other file can be given its
 * number meanwhile — not even on a filesystem that reuses freed inodes at once
 * (ext4). Birth time is deliberately NOT part of it: it is 0 where the
 * filesystem keeps none (ext2/3, small-inode ext4, NFS, some FUSE), and
 * where statx is unavailable libuv reports ctime in its place, which ffmpeg's
 * in-place writes change — either way it would make a file look foreign (a
 * leaked partial) or tell nothing. ffmpeg opens the path and writes the same
 * inode in place; no backend renames over the output.
 */
export interface FileClaim {
  path: string;
  /** `dev:ino` of the claimed file, or null when it could not be read (such a claim owns nothing). */
  identity: string | null;
  /** Closes the held descriptor. Idempotent. */
  release: () => void;
}

function identityOfPath(filePath: string): string | null {
  try {
    const st = fsSync.statSync(filePath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Takes the identity from the open descriptor; the claim then owns (and must release) it. */
function takeClaim(filePath: string, fd: number): FileClaim {
  let identity: string | null = null;
  try {
    const st = fsSync.fstatSync(fd, { bigint: true });
    identity = `${st.dev}:${st.ino}`;
  } catch {
    identity = null;
  }
  let open = true;
  return {
    path: filePath,
    identity,
    release: () => {
      if (!open) return;
      open = false;
      try {
        fsSync.closeSync(fd);
      } catch {
        // Already closed: nothing to release.
      }
    },
  };
}

/** True while the path still names the file this render claimed. A claim that could not be identified owns nothing. */
function stillOwns(claim: FileClaim): boolean {
  return claim.identity !== null && identityOfPath(claim.path) === claim.identity;
}

/** Removes the claimed file when it is still ours; never anything else that now sits at the path. Never throws. */
function removeClaimedFile(claim: FileClaim | null): void {
  if (!claim || !stillOwns(claim)) return;
  try {
    fsSync.unlinkSync(claim.path);
  } catch {
    // Already gone, or held open (Windows): nothing more to do.
  }
}

export async function renderExport(ctx: JobContext<ExportParams>, target: ExportTarget, opts: RenderExportOptions = {}): Promise<ExportResult> {
  const { pieceId, source, filename, settings } = ctx.params;

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
  manifest = manifestAsExported(manifest);

  // Spec §5.2, enforced HERE rather than only in /api/export: a job enqueued
  // any other way (`POST /api/jobs {kind:"export"}`, a retry, a future
  // caller) must not quietly default to "include" and ship the song. Judged
  // on the manifest AS EXPORTED, like the route. An explicit
  // `copyrightedAudio` is an answer too.
  const pieceFiles = filesForManifest(manifest);
  if (!settings.purpose && !settings.copyrightedAudio) {
    const songs = pieceAudioOf(manifest, pieceFiles).copyrighted;
    if (songs.length > 0) throw new Error(purposeRequiredMessage(songs));
  }

  // Copyrighted audio (spec §5.1): dropped from the MANIFEST so every backend
  // — stream-copy, the ffmpeg graph, the chromium mux — sees the same clips.
  const audioPolicy = resolveExportAudio(manifest, pieceFiles, {
    purpose: settings.purpose,
    copyrightedAudio: settings.copyrightedAudio,
    includeFileIds: settings.includeFileIds,
    excludeFileIds: settings.excludeFileIds,
  });
  if (audioPolicy.excludedFileIds.length > 0) {
    manifest = { ...manifest, audioClips: applyAudioExclusion(manifest.audioClips, audioPolicy.excludedFileIds) };
    logger.info(
      { tag: "social-music", op: "export_audio_excluded", jobId: ctx.jobId, pieceId, excluded: audioPolicy.excludedFileIds.length, purpose: settings.purpose ?? null },
      "audio left out of this export",
    );
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

  const classified = classifyExportShape(composition);
  if (classified.tag === "error") throw new Error(`Composition cannot be exported: ${classified.reason}`);
  let shape = classified.tag;
  if (shape === "canvas-source") shape = "chromium-render"; // browser-only — not reachable from server runner

  // If target dims differ from composition AND the classifier picked
  // stream-copy-trim, upgrade to ffmpeg-overlay so the upscale stage runs.
  if (
    shape === "stream-copy-trim" &&
    (resolvedSettings.width !== composition.width || resolvedSettings.height !== composition.height)
  ) {
    shape = "ffmpeg-overlay";
  }

  // With `-c copy`, the base's audio would already come out `-an`: excluding
  // a file removes its inline clip from the manifest above, so
  // `keepsBaseAudio` (lib/export/export-base.ts) — which StreamCopyTrimBackend
  // reads to decide `-an` vs `-map …audio` — sees no clip left once the
  // excluded file WAS the base's own audio. Forcing ffmpeg-overlay here is
  // defence in depth, not the thing that mutes it.
  if (shape === "stream-copy-trim" && audioPolicy.excludedFileIds.length > 0) shape = "ffmpeg-overlay";

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
  // deliberately BEFORE `claimExportFile` so a failed or cancelled download
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
  // throw from `claimExportFile` between the download and the render,
  // which used to leak a poll that outlived the failed job.
  const ac = new AbortController();
  const cancelPoll = setInterval(() => {
    if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
  }, 500);
  let reservation: Reservation | null = null;
  let ownsReservation = false;
  // The claimed file, held open while the render runs (see `FileClaim`). Released here
  // unless the caller took the claim over with `onClaimed`.
  const claimed: { claim: FileClaim | null; handedOver: boolean } = { claim: null, handedOver: false };

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

    // ── Admission ───────────────────────────────────────────────────────
    // After the Chromium download (a download is not a render) and before the
    // claim (a waiting export holds no file). A cancel while it waits leaves
    // the queue at once (`ac` aborts on the cancel poll).
    if (opts.reservation) {
      reservation = opts.reservation;
    } else {
      reservation = await getExportScheduler().acquire({
        id: opts.schedulerId ?? (target.kind === "record" ? target.exportId : ctx.jobId),
        priority: opts.priority ?? "foreground",
        estimate: await estimateFor(shape, resolvedSettings),
        signal: ac.signal,
        onWait: opts.onWait,
      });
      ownsReservation = true;
    }
    opts.onAdmitted?.();

    // Claim the destination path atomically.
    const ext = resolvedSettings.format;
    const { path: outputPath, fd: claimFd } = await claimOutputPath(target, pieceId, filename, ext);
    const claim = takeClaim(outputPath, claimFd);
    claimed.claim = claim;
    if (opts.onClaimed) {
      opts.onClaimed(claim);
      claimed.handedOver = true;
    }
    // From here a throw is cleaned up by the catch below (the claimed placeholder is ours to remove).
    try {
      // Handed to the backends: their own cleanup of a failed run is skipped once the path is no longer ours.
      const ownsOutput = () => stillOwns(claim);

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

      let durationSeconds = 0;
      let droppedOverlays: DroppedOverlay[] | undefined;
      let unloadedFonts: ExportResult["unloadedFonts"];

      if (shape === "stream-copy-trim") {
        const backend = new StreamCopyTrimBackend();
        const result = await backend.run({
          composition,
          settings: resolvedSettings,
          outputPath,
          onProgress,
          signal: ac.signal,
          ownsOutput,
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
          forceSoftwareEncoder: reservation?.software === true,
          ownsOutput,
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
        // Which of them were video clips, and their names — read from the
        // manifest and the files table here, not taken from the render page.
        const exported = composition.overlays ?? [];
        droppedOverlays = result.droppedOverlays?.length
          ? describeDroppedOverlays(
              result.droppedOverlays,
              exported,
              fileNamesOf(droppedVideoFileIds(result.droppedOverlays, exported), ctx.jobId),
            )
          : undefined;
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
        // Cancelled or deleted while it rendered, and the name since taken: never write into their file.
        if (!ownsOutput()) throw new Error(EXPORT_DELETED_MESSAGE);
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
        audioDecision: audioPolicy.decision,
        ...(droppedOverlays?.length ? { droppedOverlays } : {}),
        ...(unloadedFonts?.length ? { unloadedFonts } : {}),
      };
    } catch (err) {
      // Clean up the claimed placeholder/partial file — ours only (see `FileClaim`).
      removeClaimedFile(claim);
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
      // The hardware encoder refused a session despite B0's cap: run fewer at once from now on.
      // (The line above kept ffmpeg's own words; the user gets the plain sentence.)
      if (!isCancel && reservation?.usesHwEncoder && isHwEncoderSessionError(message)) {
        getExportScheduler().lowerHwSessionCap(reservation.id);
        throw new Error(HW_SESSION_FAILED_MESSAGE);
      }
      throw err;
    }
  } finally {
    clearInterval(cancelPoll);
    // The descriptor stays open through the catch above (its cleanup compares identities).
    if (!claimed.handedOver) claimed.claim?.release();
    // ALWAYS give the slot back — a failed or cancelled export included.
    if (ownsReservation) reservation?.release();
  }
}

/**
 * Claim the output file atomically (`claimExportFile`: a `wx` placeholder,
 * `-1`/`-2` on collision). For a record the file goes in the piece's exports
 * folder under the record's name, and the record learns the name the claim
 * settled on — the file's stem IS the export's name.
 */
async function claimOutputPath(target: ExportTarget, pieceId: string, filename: string, ext: string): Promise<{ path: string; fd: number }> {
  if (target.kind === "dir") {
    fsSync.mkdirSync(target.dir, { recursive: true });
    return claimExportFile(target.dir, filename, ext);
  }
  const record = getExportRecord(target.exportId);
  if (!record) throw new Error(EXPORT_DELETED_MESSAGE);
  const dir = await exportsDirFor(pieceId);
  fsSync.mkdirSync(dir, { recursive: true });
  const claimedFile = claimExportFile(dir, record.name, ext);
  const fileName = path.basename(claimedFile.path);
  try {
    setExportFile(target.exportId, { name: fileStem(fileName), relPath: relPathFor(fileName) });
  } catch (err) {
    // Nothing else holds this descriptor yet, and no record points at the placeholder: the file is ours alone.
    try {
      fsSync.unlinkSync(claimedFile.path);
    } catch {
      // Already gone.
    }
    fsSync.closeSync(claimedFile.fd);
    throw err;
  }
  return claimedFile;
}

/**
 * The admission estimate for this export (lib/export/cost.ts). A Chromium
 * render is sized by the render mode `export_render` last probed (software →
 * up to 4 pages, GPU → 1); until one has run in this process the mode is
 * unknown and it is estimated as ONE page, rather than assuming software.
 */
async function estimateFor(shape: ExportResult["backend"], settings: ExportSettings): Promise<CostEstimate> {
  const cores = os.cpus().length;
  const scheduler = getExportScheduler();
  const encoders = shape === "ffmpeg-overlay" && settings.format === "mp4" ? await detectAvailableEncoders() : new Set<string>();
  const hwEncoderAvailable = (pickEncoder("h264", encoders, process.platform) ?? "libx264") !== "libx264";
  const renderWorkers =
    shape === "chromium-render"
      ? resolveChunkWorkers(process.env.LIBI_RENDER_CHUNK_WORKERS, scheduler.knownRenderMode(), cores, scheduler.heldRenderWorkers())
      : 0;
  return estimateCost({ backend: shape, width: settings.width, height: settings.height, format: settings.format, cores, hwEncoderAvailable, renderWorkers });
}

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

/** `name` / `filename` of the given files, for naming a dropped clip. Only a label: by the time
 *  it runs the export is rendered, so a failed lookup leaves the clips unnamed ("an unnamed
 *  clip") and is logged — it never fails the export. */
function fileNamesOf(ids: string[], jobId: string): Map<string, { name: string; filename: string }> {
  if (!ids.length) return new Map();
  try {
    const rows = getDb()
      .select({ id: filesTable.id, name: filesTable.name, filename: filesTable.filename })
      .from(filesTable)
      .where(inArray(filesTable.id, ids))
      .all();
    return new Map(rows.map((r) => [r.id, { name: r.name, filename: r.filename }]));
  } catch (err) {
    exportLogger.warn(
      { op: "dropped_clip_names_failed", jobId, error: err instanceof Error ? err.message : String(err) },
      "export.dropped_clip_names_failed",
    );
    return new Map();
  }
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
