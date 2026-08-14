import { NextResponse } from "next/server";
import { getTrackJob } from "@/lib/tracking/track-jobs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const job = getTrackJob(jobId, token);
  if (!job) {
    return NextResponse.json({ error: "not found or wrong token" }, { status: 404 });
  }
  return NextResponse.json({ jobId: job.jobId, payload: job.payload });
}
