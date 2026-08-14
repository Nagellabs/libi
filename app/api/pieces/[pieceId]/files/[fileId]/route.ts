import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getStorage } from "@/lib/storage";
import { removeReferencesToFile } from "@/lib/composition/persistence";
import { dropProxyFile } from "@/lib/proxy/lifecycle";
import { dropFilmstripFile } from "@/lib/filmstrip/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string; fileId: string }>;
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { pieceId, fileId } = await params;
  const db = getDb();

  // Look up the file and verify it belongs to this piece
  const [file] = db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.pieceId, pieceId)))
    .limit(1)
    .all();

  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  dropProxyFile(fileId, "delete");
  dropFilmstripFile(fileId, "delete");

  // Delete from storage (proceed with DB delete even if file already gone)
  try {
    const storage = await getStorage();
    await storage.delete(pieceId, file.filename);
  } catch {
    // File may already be gone from disk — still remove DB record
  }

  // Delete DB record
  db.delete(files).where(eq(files.id, fileId)).run();

  // Cascade: remove any video scenes or audio tracks referencing this file
  try {
    await removeReferencesToFile(pieceId, fileId);
  } catch {
    // Composition may not exist yet — safe to ignore
  }

  return NextResponse.json({ success: true });
}
