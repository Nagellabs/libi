import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { listExportViews } from "@/lib/exports/store";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/** GET /api/pieces/:pieceId/exports — every export of the piece, oldest first,
 *  every status. Sorting and filtering are the client's (tens of rows). */
export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const [piece] = getDb().select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).limit(1).all();
  if (!piece) return NextResponse.json({ error: "Piece not found" }, { status: 404 });
  return NextResponse.json({ exports: await listExportViews(pieceId) });
}
