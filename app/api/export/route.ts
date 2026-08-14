import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { getJobManager } from "@/lib/jobs/manager";
import { loadComposition } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { resolveExportSettings } from "@/lib/export/quality";
import { resolveExportFolder, getExportDefaults } from "@/lib/db/settings";
import { isFolderWritable, ensureFolderExists } from "@/lib/export/folder";
import { exportLogger } from "@/lib/logger";

/** Body accepted by POST /api/export. All fields except pieceId are optional —
 *  defaults come from the export-defaults settings + the piece's composition. */
interface Body {
  pieceId: string;
  source?: "draft" | "snapshot";
  filename?: string;
  format?: "mp4" | "webm";
  quality?: "source" | "1080p" | "1440p" | "4k" | "custom";
  customWidth?: number;
  customHeight?: number;
  destFolder?: string;
}

/** Enqueues a unified `export` job and returns { jobId } so the caller can
 *  watch progress via /api/jobs/[id]/events (SSE) and cancel via DELETE. */
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

  const db = getDb();
  const [piece] = db.select().from(pieces).where(eq(pieces.id, body.pieceId)).limit(1).all();
  if (!piece) {
    return NextResponse.json({ error: `Piece not found: ${body.pieceId}` }, { status: 404 });
  }

  const source = body.source ?? "draft";

  // Load the composition just enough to derive native dimensions for the
  // "source" quality preset. The runner re-loads inside the job for the
  // actual encode.
  let width: number;
  let height: number;
  let fps: number;
  if (source === "snapshot") {
    const snap = await loadCurrentSnapshot(body.pieceId);
    if (!snap) {
      return NextResponse.json({ error: "No committed snapshot" }, { status: 404 });
    }
    width = snap.width;
    height = snap.height;
    fps = snap.fps;
  } else {
    const { manifest } = await loadComposition(body.pieceId);
    width = manifest.width;
    height = manifest.height;
    fps = manifest.fps;
  }

  const defaults = getExportDefaults();
  const format = body.format ?? defaults.format;
  const requestedQuality = body.quality ?? defaults.quality;
  // The runner only understands settings.quality; "custom" needs explicit dims.
  if (requestedQuality === "custom" && (!body.customWidth || !body.customHeight)) {
    return NextResponse.json(
      { error: "custom quality requires customWidth and customHeight" },
      { status: 400 },
    );
  }

  // Codec is server-derived from format. MP4 → H.264 (avc), WebM → VP9.
  // We intentionally don't accept a `codec` field from the client — see the
  // runner's `exportParamsSchema` comment. Future AV1 support would expose
  // a new format ("mp4-av1") rather than splitting the (format, codec) pair.
  const settings = resolveExportSettings({
    format,
    codec: format === "webm" ? "vp9" : "avc",
    fps,
    quality: requestedQuality,
    sourceWidth: width,
    sourceHeight: height,
    customWidth: body.customWidth,
    customHeight: body.customHeight,
  });

  const destFolder = (body.destFolder?.trim() || resolveExportFolder()).trim();
  // Try to create the folder up front. Fail with 400 if we can't.
  try {
    ensureFolderExists(destFolder);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Cannot create export folder: ${msg}` },
      { status: 400 },
    );
  }
  if (!isFolderWritable(destFolder)) {
    return NextResponse.json(
      { error: `Export folder is not writable: ${destFolder}` },
      { status: 400 },
    );
  }

  // Default filename = piece.name; the runner sanitizes and applies the
  // collision-suffix logic so concurrent exports never overwrite each other.
  const filename = (body.filename?.trim() || piece.name).trim();

  const mgr = getJobManager();
  const enq = await mgr.enqueue(
    "export",
    {
      pieceId: body.pieceId,
      source,
      filename,
      settings,
      destFolder,
    },
    {
      // Every export is a fresh run — re-using a completed export for a new
      // request would skip the actual render and the new output filename.
      forceNew: true,
      pieceId: body.pieceId,
    },
  );
  if (enq.status !== "new") {
    return NextResponse.json(
      { error: `Unexpected enqueue result: ${enq.status}` },
      { status: 500 },
    );
  }

  // Kick the runner so the export actually starts. `enqueue()` only inserts
  // the row — the JobManager doesn't auto-dispatch. We mirror the pattern in
  // /api/jobs POST: fire-and-forget runToCompletion, log on failure (the SSE
  // stream surfaces the failure to the client).
  const jobIdForLog = enq.jobId;
  void mgr.runToCompletion(jobIdForLog).catch((err) => {
    exportLogger.warn(
      {
        event: "background_failed",
        jobId: jobIdForLog,
        err: err instanceof Error ? err.message : String(err),
      },
      "export.background_failed",
    );
  });

  exportLogger.info(
    {
      event: "enqueue",
      jobId: enq.jobId,
      pieceId: body.pieceId,
      source,
      filename,
      format,
      quality: settings.quality,
      width: settings.width,
      height: settings.height,
      destFolder,
    },
    "export.enqueue",
  );

  return NextResponse.json({
    jobId: enq.jobId,
    destFolder,
    filename,
    settings: {
      format: settings.format,
      width: settings.width,
      height: settings.height,
      bitrate: settings.bitrate,
      quality: settings.quality,
    },
  });
}
