import { NextResponse } from "next/server";
import { getRenderJob } from "@/lib/export/render-jobs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const token = req.headers.get("x-render-token") ?? "";
  const entry = getRenderJob(jobId, token);
  if (!entry) {
    return NextResponse.json({ error: "Job not found or token invalid" }, { status: 404 });
  }
  return NextResponse.json({
    jobId: entry.jobId,
    pieceId: entry.pieceId,
    payload: entry.payload,
    settings: entry.settings,
  });
}
