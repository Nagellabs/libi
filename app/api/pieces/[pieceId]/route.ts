import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import { getFolder } from "@/lib/folders/repo";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const db = getDb();

  const [piece] = await db
    .select()
    .from(pieces)
    .where(eq(pieces.id, pieceId));

  if (!piece) {
    return Response.json({ error: "Piece not found" }, { status: 404 });
  }

  return Response.json(piece);
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const body = await req.json();
  const db = getDb();

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) {
    updateData.name = body.name;
    updateData.nameSetByUser = true;
  }
  if (body.description !== undefined) updateData.description = body.description;
  if (body.folderId !== undefined) {
    const folderId = body.folderId === null ? null : String(body.folderId);
    if (folderId && !getFolder(folderId)) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    updateData.folderId = folderId;
  }

  const [updated] = await db
    .update(pieces)
    .set(updateData)
    .where(eq(pieces.id, pieceId))
    .returning();

  if (!updated) {
    return Response.json({ error: "Piece not found" }, { status: 404 });
  }

  navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId });
  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });

  return Response.json(updated);
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const ok = await deletePieceCompletely(pieceId);
  if (!ok) {
    return Response.json({ error: "Piece not found" }, { status: 404 });
  }
  return Response.json({ success: true });
}
