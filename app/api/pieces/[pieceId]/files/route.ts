import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const db = getDb();

  const result = db
    .select()
    .from(files)
    .where(eq(files.pieceId, pieceId))
    .orderBy(desc(files.createdAt))
    .all();

  return NextResponse.json({ files: result });
}
