import { NextResponse } from "next/server";
import { listActiveExportViews } from "@/lib/exports/store";

/**
 * GET /api/exports — every export still queued or running, across pieces (the
 * running-count badges). Effect-free: it reads and reconciles for the answer,
 * it never writes a status or emits (`listActiveExportViews`).
 */
export async function GET() {
  return NextResponse.json({ exports: await listActiveExportViews() });
}
