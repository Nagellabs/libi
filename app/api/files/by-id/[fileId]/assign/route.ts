import { NextResponse } from "next/server";
import { assignFile } from "@/mcp/tools/file-tools";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  const { fileId } = await params;

  let body: { pieceId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { pieceId } = body;
  if (pieceId !== null && typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId must be a string or null" }, { status: 400 });
  }

  const db = getDb();
  const [pre] = db.select().from(filesTable).where(eq(filesTable.id, fileId)).limit(1).all();
  const oldPieceId = pre?.pieceId ?? null;

  const result = await assignFile({ fileId, pieceId: pieceId ?? null });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  const newPieceId = pieceId ?? null;
  const emit = (pid: string | null) =>
    navigationEmitter.emit(
      "refresh_query",
      pid ? { queryKey: "piece", pieceId: pid } : { queryKey: "files" },
    );
  if (oldPieceId !== newPieceId) {
    emit(oldPieceId);
    emit(newPieceId);
  } else {
    emit(newPieceId);
  }

  return NextResponse.json(result.data);
}
