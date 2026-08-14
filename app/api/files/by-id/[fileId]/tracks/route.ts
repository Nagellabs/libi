import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { listTracksByFile } from "@/lib/tracking/repo";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const db = getDb();
  const rows = await listTracksByFile(db, fileId);
  return NextResponse.json({ tracks: rows });
}
