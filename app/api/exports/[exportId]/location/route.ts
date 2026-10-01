import fs from "node:fs";
import { NextResponse } from "next/server";
import { getExportRecord } from "@/lib/exports/store";
import { absoluteExportPath } from "@/lib/exports/paths";

interface RouteParams {
  params: Promise<{ exportId: string }>;
}

/**
 * GET /api/exports/:exportId/location — the export's absolute path and whether
 * it is still there. Same contract as `/api/files/by-id/:id/location`: the
 * only input is an id, the answer describes only the path derived from its row.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { exportId } = await params;
  const row = getExportRecord(exportId);
  if (!row || !row.relPath) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const abs = await absoluteExportPath(row.pieceId, row.relPath);
    return NextResponse.json({ path: abs, exists: fs.existsSync(abs) });
  } catch {
    return NextResponse.json({ error: "Unresolvable" }, { status: 500 });
  }
}
