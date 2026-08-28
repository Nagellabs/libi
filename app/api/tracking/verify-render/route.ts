import * as path from "node:path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { readTrack } from "@/lib/tracking/storage";
import { summarizeTrack } from "@/lib/tracking/summary";
import { loadManifest } from "@/lib/composition/persistence";
import { selectVerifyTimes } from "@/lib/tracking/verify-grid";
import { renderVerifyFrames } from "@/lib/tracking/verify-render";
import { prepareTrackForRender } from "@/lib/tracking/prepare-overlay-tracks";
import { resizeAnchorFromOffset } from "@/lib/tracking/size-stabilize";
import { storeFile } from "@/mcp/tools/file-tools";
import { serverLogger as logger } from "@/lib/logger";
import { isSafePieceId, isSafeTrackId } from "@/lib/security/pieceId";
import type { TrackedContent, TrackFit, TrackSmoothing } from "@/lib/tracking/types";

interface Body {
  fileId?: string; trackId?: string; content?: TrackedContent; fit?: TrackFit;
  scale?: number; smoothing?: TrackSmoothing;
  offset?: { x: number; y: number };
  pieceId?: string; overlayId?: string;
  sizeMode?: "stabilized" | "raw"; maxBoxScale?: number;
  positionMode?: "stabilized" | "raw";
  focusRange?: { start: number; end: number };
  extraTimes?: number[]; persist?: number[];
}

export async function POST(req: Request) {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  // RC-D: `body.pieceId` is raw client input that flows into
  // readTrack/loadManifest → path.join(getLibiStorageDir(), pieceId, …),
  // bypassing the LocalFileStorage guard. Reject a traversal id before any read.
  if (body.pieceId !== undefined && !isSafePieceId(body.pieceId)) {
    return NextResponse.json(
      { success: false, error: "invalid pieceId" },
      { status: 400 },
    );
  }
  // `body.trackId` (pre-attach branch) is likewise raw client input that flows
  // into readTrack's filename component. The post-attach branch's trackId comes
  // from the trusted overlay manifest, so only guard the client-supplied one.
  if (body.trackId !== undefined && !isSafeTrackId(body.trackId)) {
    return NextResponse.json(
      { success: false, error: "invalid trackId" },
      { status: 400 },
    );
  }

  const pre = !!(body.fileId && body.trackId && body.content && body.fit);
  const post = !!(body.pieceId && body.overlayId);
  if ((pre && post) || (!pre && !post)) {
    return NextResponse.json(
      { success: false, error: "provide EITHER pre-attach OR post-attach params" },
      { status: 400 },
    );
  }

  const db = getDb();
  let fileId: string;
  let trackId: string;
  let content: TrackedContent;
  let fit: TrackFit;
  let scale = body.scale ?? 1;
  let smoothing: TrackSmoothing = body.smoothing ?? "linear";
  let offset: { x: number; y: number } | undefined = body.offset;
  let sizeMode: "stabilized" | "raw" = body.sizeMode ?? "stabilized";
  let maxBoxScale = body.maxBoxScale ?? 1.75;
  let positionMode: "stabilized" | "raw" = body.positionMode ?? "stabilized";

  if (post) {
    const manifest = await loadManifest(body.pieceId!);
    const ov = (manifest.overlays ?? []).find((o) => o.id === body.overlayId);
    if (!ov || ov.kind !== "tracked") {
      return NextResponse.json(
        { success: false, error: `tracked overlay not found: ${body.overlayId}` },
        { status: 404 },
      );
    }
    trackId = ov.trackId;
    content = ov.content as TrackedContent;
    fit = ov.fit as TrackFit;
    scale = ov.scale;
    smoothing = ov.smoothing as TrackSmoothing;
    sizeMode = ov.sizeMode ?? "stabilized";
    maxBoxScale = ov.maxBoxScale ?? 1.75;
    positionMode = ov.positionMode ?? "stabilized";
    offset = (ov as { offset?: { x: number; y: number } }).offset ?? offset;
    const trk = await readTrack(body.pieceId!, trackId);
    if (!trk) {
      return NextResponse.json({ success: false, error: "track sidecar missing" }, { status: 404 });
    }
    fileId = trk.fileId;
  } else {
    fileId = body.fileId!;
    trackId = body.trackId!;
    content = body.content!;
    fit = body.fit!;
  }

  const fileRows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return NextResponse.json({ success: false, error: "file not found" }, { status: 404 });
  if (!file.pieceId)
    return NextResponse.json({ success: false, error: "file not assigned to a piece" }, { status: 400 });

  const track = await readTrack(file.pieceId, trackId);
  if (!track)
    return NextResponse.json({ success: false, error: `track not found: ${trackId}` }, { status: 404 });

  // Render EXACTLY what the editor shows — delegate to the ONE hydration
  // seam (anchor merge → size stabilize → position stabilize) instead of
  // composing the transforms independently here. Without this the agent's
  // visual-verify would judge a different pipeline than preview/export.
  const prepared = prepareTrackForRender(track, {
    sizeMode,
    maxBoxScale,
    positionMode,
    resizeAnchor: resizeAnchorFromOffset(offset),
  });

  const frameW = file.mediaWidth ?? 1920;
  const frameH = file.mediaHeight ?? 1080;
  const clip = file.mediaDuration ?? prepared.durationSec;

  const summary = summarizeTrack(prepared, {
    frameW, frameH, clipDurationSec: clip,
  });

  const manualAnchorTimes = (track.manualAnchors ?? []).map((a) => a.time);
  const agentAnchorTimes = (track.agentAnchors ?? []).map((a) => a.time);

  const grid = selectVerifyTimes({
    clipDurationSec: clip,
    fps: prepared.framerate || 30,
    // Anchor frames are correct by construction — drift hides BETWEEN
    // anchors, so exclude manual AND agent anchor times from the grid.
    manualAnchorTimes: [
      ...manualAnchorTimes,
      ...agentAnchorTimes,
      ...(track.anchors ?? []).map((a) => a.time),
    ],
    issueRanges: summary.issues.map((i) => i.range),
    lostRanges: summary.lostRanges,
    focusRange: body.focusRange ?? null,
    extraTimes: body.extraTimes ?? [],
  });

  const srcPath = path.isAbsolute(file.storagePath)
    ? file.storagePath
    : path.join(getLibiStorageDir(), file.storagePath);

  const { frames } = await renderVerifyFrames({
    track: prepared, srcPath, frameW, frameH,
    times: grid.times, content, fit, scale, smoothing, offset,
    manualAnchorTimes,
    agentAnchorTimes,
  });

  const persistedFileIds: Record<string, string> = {};
  for (const t of body.persist ?? []) {
    const fr = frames.find((f) => Math.abs(f.time - t) < 1e-6);
    if (!fr?.pngBase64) continue;
    try {
      const stored = await storeFile({
        pieceId: null,
        filename: `verify-${trackId.slice(0, 8)}-${t.toFixed(2)}s.png`,
        buffer: Buffer.from(fr.pngBase64, "base64"),
        contentType: "image/png",
        name: `verify ${trackId} @ ${t.toFixed(2)}s`,
        description: `Tracked-overlay verify frame for ${trackId} at ${t.toFixed(2)}s`,
      });
      persistedFileIds[String(t)] = stored.id;
    } catch (e) {
      logger.warn(
        { tag: "tracking-verify", op: "verify.persist.fail", err: e instanceof Error ? e.message : String(e) },
        "verify frame persist failed",
      );
    }
  }

  return NextResponse.json({
    success: true,
    frames,
    summary,
    segments: summary.perSegment,
    truncated: grid.truncated,
    coveredIssueRanges: grid.coveredIssueRanges,
    persistedFileIds,
  });
}
