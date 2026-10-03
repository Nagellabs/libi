import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { getJobManager } from "@/lib/jobs/manager";
import { isCancelledError } from "@/lib/jobs/types";
import { loadComposition, type CompositionManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import {
  resolveExportSettingsWithTier,
  hasGraphicsOverlays,
  usesSocialFit,
  SOCIAL_FIT,
  SOCIAL_DEFAULT_QUALITY,
  SOCIAL_DEFAULT_GRAPHICS_QUALITY,
} from "@/lib/export/quality";
import { getExportDefaults } from "@/lib/db/settings";
import { exportLogger } from "@/lib/logger";
import { chromiumInstalled, CHROMIUM_DOWNLOAD_MB } from "@/lib/export/ensure-chromium";
import { filesForManifest } from "@/lib/audio-rights/piece-reader";
import { pieceAudioOf } from "@/lib/audio-rights/piece-audio";
import { purposeRequiredMessage, resolveExportAudio } from "@/lib/export/audio-policy";
import { trackServerEvent } from "@/lib/analytics/server";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { createExportRecord, deleteExportRecord, newExportId, setExportJob, uniqueExportName } from "@/lib/exports/store";
import { DEST_FOLDER_REFUSAL, variantsBucket, type ExportStartedBy } from "@/lib/exports/types";

const GRAPHICS_QUALITIES: ReadonlyArray<string> = ["1080p", "1440p", "4k"];
const EXPORT_PURPOSES: ReadonlyArray<string> = ["social", "personal"];
const COPYRIGHTED_AUDIO_MODES: ReadonlyArray<string> = ["exclude", "include"];

/** Body accepted by POST /api/export. All fields except pieceId are optional —
 *  defaults come from the export-defaults settings + the piece's composition. */
interface Body {
  pieceId: string;
  source?: "draft" | "snapshot";
  filename?: string;
  format?: "mp4" | "webm";
  quality?: "source" | "1080p" | "1440p" | "4k" | "custom";
  graphicsQuality?: "1080p" | "1440p" | "4k";
  customWidth?: number;
  customHeight?: number;
  /** Removed (exports are saved in the piece). Present → 400, never ignored. */
  destFolder?: unknown;
  purpose?: "social" | "personal";
  copyrightedAudio?: "exclude" | "include";
  includeFileIds?: string[];
  excludeFileIds?: string[];
  /** How many exports the caller queued in one go (libi.export_video's
   *  `variants`); analytics only. */
  batchSize?: number;
}

/** Enqueues a unified `export` job with its `piece_exports` record and returns
 *  { jobId, exportId, name } so the caller can watch progress via
 *  /api/jobs/[id]/events (SSE) and cancel via DELETE. */
export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.pieceId) {
    return NextResponse.json({ error: "Missing pieceId" }, { status: 400 });
  }
  // Exports are saved in the piece (spec 2026-09-29 §A2). An old caller's
  // destFolder is refused, never silently ignored: the file would not be where
  // it asked for it.
  if (body.destFolder !== undefined) {
    return NextResponse.json({ error: "dest_folder_removed", message: DEST_FOLDER_REFUSAL }, { status: 400 });
  }

  const db = getDb();
  const [piece] = db.select().from(pieces).where(eq(pieces.id, body.pieceId)).limit(1).all();
  if (!piece) {
    return NextResponse.json({ error: `Piece not found: ${body.pieceId}` }, { status: 404 });
  }

  const source = body.source ?? "draft";

  // Load the composition just enough to derive native dimensions for the
  // "source" quality preset, and its overlays to know whether any text/code/
  // 3D graphics are present (drives the graphics-resolution comparison). The
  // runner re-loads inside the job for the actual encode.
  let width: number;
  let height: number;
  let fps: number;
  let hasGraphics: boolean;
  let loaded: CompositionManifest;
  if (source === "snapshot") {
    const snap = await loadCurrentSnapshot(body.pieceId);
    if (!snap) {
      return NextResponse.json({ error: "No committed snapshot" }, { status: 404 });
    }
    width = snap.width;
    height = snap.height;
    fps = snap.fps;
    hasGraphics = hasGraphicsOverlays(snap.overlays);
    loaded = snap;
  } else {
    const { manifest } = await loadComposition(body.pieceId);
    width = manifest.width;
    height = manifest.height;
    fps = manifest.fps;
    hasGraphics = hasGraphicsOverlays(manifest.overlays);
    loaded = manifest;
  }

  // Validate the audio options up front, the same way graphicsQuality is
  // below — a bad value fails loud with a 400 rather than silently reaching
  // the runner (which would just treat an unrecognized purpose as absent).
  if (body.purpose !== undefined && !EXPORT_PURPOSES.includes(body.purpose)) {
    return NextResponse.json(
      { error: `purpose must be one of ${EXPORT_PURPOSES.join(", ")}` },
      { status: 400 },
    );
  }
  if (body.copyrightedAudio !== undefined && !COPYRIGHTED_AUDIO_MODES.includes(body.copyrightedAudio)) {
    return NextResponse.json(
      { error: `copyrightedAudio must be one of ${COPYRIGHTED_AUDIO_MODES.join(", ")}` },
      { status: 400 },
    );
  }
  if (
    body.includeFileIds !== undefined &&
    (!Array.isArray(body.includeFileIds) || body.includeFileIds.some((id) => typeof id !== "string"))
  ) {
    return NextResponse.json({ error: "includeFileIds must be an array of strings" }, { status: 400 });
  }
  if (
    body.excludeFileIds !== undefined &&
    (!Array.isArray(body.excludeFileIds) || body.excludeFileIds.some((id) => typeof id !== "string"))
  ) {
    return NextResponse.json({ error: "excludeFileIds must be an array of strings" }, { status: 400 });
  }

  // Spec §5.2: a piece with copyrighted music says what the export is for.
  // Judged AFTER hidden layers are stripped (mirrors `renderExport`,
  // lib/jobs/runners/export.ts) — a song that lives only on a hidden layer
  // never reaches this export, so it must never demand a purpose.
  loaded = manifestAsExported(loaded);
  const pieceFiles = filesForManifest(loaded);
  const pieceAudio = pieceAudioOf(loaded, pieceFiles);
  if (pieceAudio.copyrighted.length > 0 && !body.purpose) {
    return NextResponse.json({ error: "purpose_required", message: purposeRequiredMessage(pieceAudio.copyrighted) }, { status: 422 });
  }
  const audioOpts = {
    ...(body.purpose ? { purpose: body.purpose } : {}),
    ...(body.copyrightedAudio ? { copyrightedAudio: body.copyrightedAudio } : {}),
    ...(body.includeFileIds ? { includeFileIds: body.includeFileIds } : {}),
    ...(body.excludeFileIds ? { excludeFileIds: body.excludeFileIds } : {}),
  };

  const defaults = getExportDefaults();
  const format = body.format ?? defaults.format;
  // A social export that names no size is fitted to 1080×1920 (the platforms'
  // ceiling), whatever the stored defaults say: 4K is opt-in, by naming
  // `quality`, `graphicsQuality` or custom dimensions (lib/export/quality.ts).
  const socialFit = usesSocialFit(body);
  const requestedQuality = socialFit ? SOCIAL_DEFAULT_QUALITY : (body.quality ?? defaults.quality);
  const requestedGraphicsQuality = socialFit ? SOCIAL_DEFAULT_GRAPHICS_QUALITY : (body.graphicsQuality ?? defaults.graphicsQuality);
  if (!GRAPHICS_QUALITIES.includes(requestedGraphicsQuality)) {
    return NextResponse.json(
      { error: `graphicsQuality must be one of ${GRAPHICS_QUALITIES.join(", ")}` },
      { status: 400 },
    );
  }
  // The runner only understands settings.quality; "custom" needs explicit dims.
  if (requestedQuality === "custom" && (!body.customWidth || !body.customHeight)) {
    return NextResponse.json(
      { error: "custom quality requires customWidth and customHeight" },
      { status: 400 },
    );
  }

  // Codec is server-derived from format. MP4 → H.264 (avc), WebM → VP9.
  // We intentionally don't accept a `codec` field from the client — see the
  // runner's `exportParamsSchema` comment. `drivenBy` says which tier set the
  // frame: "graphics" when text/code/3D raised it above what `quality` alone
  // gives (0.1.15's split). The MCP tool says so.
  const { settings, drivenBy } = resolveExportSettingsWithTier({
    format,
    codec: format === "webm" ? "vp9" : "avc",
    fps,
    quality: requestedQuality,
    graphicsQuality: requestedGraphicsQuality,
    hasGraphics,
    sourceWidth: width,
    sourceHeight: height,
    customWidth: body.customWidth,
    customHeight: body.customHeight,
    ...(socialFit ? { fitWithin: SOCIAL_FIT } : {}),
  });

  // Default filename = piece.name. The record's name is unique within the
  // piece (`-1`, `-2`), and the runner's atomic claim keeps it the file's stem.
  const filename = (body.filename?.trim() || piece.name).trim();
  const name = await uniqueExportName(body.pieceId, filename, settings.format);

  // Tell the caller, at enqueue time, whether this export may begin with a
  // ~173 MB download. The route does not classify — that needs the loaded
  // composition, which the runner does — so "Chromium is absent" is the
  // honest, cheap answer: it can over-warn for an ffmpeg-only export, never
  // under-warn.
  const chromiumDownloadMb = (await chromiumInstalled()) ? null : CHROMIUM_DOWNLOAD_MB;

  // Who started it: libi's own page sends `Sec-Fetch-Site: same-origin` itself;
  // a tool call (the MCP child, a CLI) sends none. Analytics + the record only.
  const startedBy: ExportStartedBy = req.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin" ? "user" : "agent";

  // The record exists before the job so the Exports tab shows it queued at once.
  const exportId = newExportId();
  createExportRecord({
    id: exportId,
    pieceId: body.pieceId,
    name,
    source: startedBy,
    settings: {
      format: settings.format,
      codec: settings.codec,
      fps: settings.fps,
      width: settings.width,
      height: settings.height,
      quality: settings.quality ?? null,
      graphicsQuality: settings.graphicsQuality ?? null,
      purpose: body.purpose ?? null,
    },
  });

  const mgr = getJobManager();
  let enq: Awaited<ReturnType<typeof mgr.enqueue>>;
  try {
    enq = await mgr.enqueue(
      "export",
      {
        pieceId: body.pieceId,
        source,
        filename: name,
        settings: { ...settings, ...audioOpts },
        exportId,
      },
      {
        // Every export is a fresh run — re-using a completed export for a new
        // request would skip the actual render and the new output file.
        forceNew: true,
        pieceId: body.pieceId,
      },
    );
  } catch (err) {
    deleteExportRecord(exportId);
    throw err;
  }
  if (enq.status !== "new") {
    deleteExportRecord(exportId);
    return NextResponse.json(
      { error: `Unexpected enqueue result: ${enq.status}` },
      { status: 500 },
    );
  }
  setExportJob(exportId, enq.jobId);

  // Kick the runner so the export actually starts. `enqueue()` only inserts
  // the row — the JobManager doesn't auto-dispatch. Fire-and-forget; the
  // runner settles the record, and a job cancelled before it ever ran is
  // reconciled on read (lib/exports/store.ts#staleStatus).
  const jobIdForLog = enq.jobId;
  void mgr.runToCompletion(jobIdForLog).catch((err) => {
    // A user cancel / delete surfaces here as the job layer's CancelledError — an expected end,
    // not a failure worth a warning.
    if (isCancelledError(err)) {
      exportLogger.info({ op: "background_cancelled", jobId: jobIdForLog, exportId }, "export.background_cancelled");
      return;
    }
    exportLogger.warn(
      {
        op: "background_failed",
        jobId: jobIdForLog,
        exportId,
        err: err instanceof Error ? err.message : String(err),
      },
      "export.background_failed",
    );
  });

  if (pieceAudio.copyrighted.length > 0 && body.purpose) {
    const resolved = resolveExportAudio(loaded, pieceFiles, audioOpts);
    trackServerEvent("export_audio_decision", { purpose: body.purpose, copyrighted: resolved.carriesCopyrighted ? "include" : "exclude" });
  }
  const batch = typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0 ? body.batchSize : 1;
  trackServerEvent("export_queued", { source: startedBy, variants: variantsBucket(batch) });

  exportLogger.info(
    {
      op: "enqueue",
      jobId: enq.jobId,
      exportId,
      pieceId: body.pieceId,
      source,
      format,
      quality: settings.quality,
      graphicsQuality: settings.graphicsQuality,
      hasGraphics,
      socialFit,
      width: settings.width,
      height: settings.height,
    },
    "export.enqueue",
  );

  return NextResponse.json({
    jobId: enq.jobId,
    exportId,
    name,
    filename: name,
    chromiumDownloadMb,
    settings: {
      format: settings.format,
      width: settings.width,
      height: settings.height,
      bitrate: settings.bitrate,
      quality: settings.quality,
      graphicsQuality: settings.graphicsQuality,
      drivenBy,
      // True when the request named no graphicsQuality and the stored default
      // was used — the case the tool's "default to 4K" note describes.
      graphicsQualityDefaulted: body.graphicsQuality === undefined,
      // True when a social export named no size and was fitted to 1080×1920.
      socialFit,
    },
  });
}
