import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { isNull, desc } from "drizzle-orm";

export async function GET() {
  const db = getDb();

  const result = db
    .select()
    .from(files)
    .where(isNull(files.pieceId))
    .orderBy(desc(files.createdAt))
    .all();

  return NextResponse.json({ files: result });
}
