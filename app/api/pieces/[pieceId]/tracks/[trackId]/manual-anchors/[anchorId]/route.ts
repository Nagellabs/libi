import { NextResponse } from "next/server";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { removeManualAnchor } from "@/lib/tracking/manual-anchors";
import { navigationEmitter } from "@/lib/navigation-events";
import { isSafePieceId, isSafeTrackId } from "@/lib/security/pieceId";

type Ctx = { params: Promise<{ pieceId: string; trackId: string; anchorId: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const { pieceId, trackId, anchorId } = await params;
  // RC-D: raw URL params flow into the track-sidecar path builders; reject
  // traversal-shaped ids with a 400 before any filesystem op.
  if (!isSafePieceId(pieceId) || !isSafeTrackId(trackId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
  const manualAnchors = removeManualAnchor(track.manualAnchors ?? [], anchorId);
  await writeTrack(pieceId, { ...track, manualAnchors });
  navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
  return NextResponse.json({ ok: true });
}
