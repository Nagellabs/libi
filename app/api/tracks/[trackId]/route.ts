import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { tracks, files } from "@/lib/db/schema/sqlite";
import { readTrack } from "@/lib/tracking/storage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ trackId: string }> }
) {
  const { trackId } = await params;
  const db = getDb();
  const trackRows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  const row = trackRows[0];
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.id, row.fileId))
    .limit(1);
  if (!fileRows[0]?.pieceId)
    return NextResponse.json({ error: "file unassigned" }, { status: 404 });
  const track = await readTrack(fileRows[0].pieceId, trackId);
  if (!track)
    return NextResponse.json({ error: "sidecar missing" }, { status: 404 });
  return NextResponse.json(track);
}
