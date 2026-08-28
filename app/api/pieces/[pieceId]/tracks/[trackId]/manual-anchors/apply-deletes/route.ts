import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { reanchorWindow, REANCHOR_WINDOW_SEC } from "@/lib/tracking/manual-anchors";
import { recomputeTrackSegmentServerSide } from "@/lib/tracking/recompute-segment";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { isSafePieceId, isSafeTrackId } from "@/lib/security/pieceId";

type Ctx = { params: Promise<{ pieceId: string; trackId: string }> };

/**
 * Apply a batch of staged anchor deletions, then re-track the windows the
 * removed anchors used to correct — WITHOUT those anchors — so each freed
 * window reverts to pure engine tracking (or to a surviving in-window
 * correction). This is the "Save changes" action of the manual-edits form:
 * the panel stages deletes locally and commits them here in one pass.
 *
 * Why a re-track is required: when an anchor was first added the segment was
 * seeded-re-tracked WITH the correction baked into its samples. Just dropping
 * the anchor from `manualAnchors[]` leaves those corrected samples in place,
 * so the delete would be visually a no-op. We must recompute the window from
 * the engine using only the REMAINING anchors as seeds.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { pieceId, trackId } = await params;
  // RC-D: raw URL params flow into the track-sidecar path builders; reject
  // traversal-shaped ids with a 400 before any filesystem op.
  if (!isSafePieceId(pieceId) || !isSafeTrackId(trackId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let parsed: { anchorIds?: unknown };
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const anchorIds = parsed.anchorIds;
  if (
    !Array.isArray(anchorIds) ||
    anchorIds.length === 0 ||
    !anchorIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "anchorIds:string[] (non-empty) required" },
      { status: 400 },
    );
  }

  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });

  const idSet = new Set(anchorIds as string[]);
  const current = track.manualAnchors ?? [];
  const removed = current.filter((a) => idSet.has(a.id));
  if (removed.length === 0) {
    return NextResponse.json({ ok: true, removed: 0, retracking: 0 });
  }

  // Distinct windows the removed anchors used to correct, derived from the
  // CURRENT track (segments still intact). Dedupe by the same bounded window
  // recomputeTrackSegmentServerSide re-tracks so two removed pins in one OK
  // segment but different ±W windows each get reverted independently.
  const remaining = current.filter((a) => !idSet.has(a.id));
  const windows = new Map<string, number>(); // rangeKey -> representative time
  for (const a of removed) {
    const range = reanchorWindow(track, a.time, REANCHOR_WINDOW_SEC);
    const key = `${range.start}-${range.end}`;
    if (!windows.has(key)) windows.set(key, a.time);
  }

  await writeTrack(pieceId, { ...track, manualAnchors: remaining });
  // Anchor list changed — repaint the panel/markers immediately, before the
  // (slower) background re-track of each freed window completes.
  navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });

  const db = getDb();
  const fileId = track.fileId;
  for (const repTime of windows.values()) {
    void recomputeTrackSegmentServerSide({ db, fileId, trackId, time: repTime, manualAnchors: remaining })
      .then(() => {
        navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
      })
      .catch((err) => {
        logger.error(
          { tag: "tracking-reanchor", op: "apply-deletes.recompute.error", trackId, err },
          "revert re-track segment failed",
        );
      });
  }

  return NextResponse.json({ ok: true, removed: removed.length, retracking: windows.size });
}
