import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { dropProxyFile } from "@/lib/proxy/lifecycle";
import { dropFilmstripFile } from "@/lib/filmstrip/lifecycle";
import { enqueueProxyGen } from "@/lib/proxy/enqueue";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const db = getDb();

  const [file] = db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  db.update(files).set({ name }).where(eq(files.id, fileId)).run();

  // Preserves the legacy ProxyManager.invalidate() semantics: drop the old
  // proxy bytes + clear the row's proxy_* columns, then re-enqueue a fresh
  // proxy_gen job in the background.
  if (file.type === "video") {
    dropProxyFile(fileId, "user");
    // Drop the cached filmstrip too; the timeline lazily re-ensures it on next view.
    dropFilmstripFile(fileId, "user");
    enqueueProxyGen(fileId, { pieceId: file.pieceId, regenerate: true });
  }

  if (file.pieceId) {
    navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId: file.pieceId });
  } else {
    navigationEmitter.emit("refresh_query", { queryKey: "files" });
  }

  return NextResponse.json({ success: true, file: { ...file, name } });
}
