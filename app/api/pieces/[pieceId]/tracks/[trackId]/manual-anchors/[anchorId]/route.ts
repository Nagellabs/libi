import { NextResponse } from "next/server";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { removeManualAnchor } from "@/lib/tracking/manual-anchors";
import { navigationEmitter } from "@/lib/navigation-events";

type Ctx = { params: Promise<{ pieceId: string; trackId: string; anchorId: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const { pieceId, trackId, anchorId } = await params;
  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
  const manualAnchors = removeManualAnchor(track.manualAnchors ?? [], anchorId);
  await writeTrack(pieceId, { ...track, manualAnchors });
  navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
  return NextResponse.json({ ok: true });
}
