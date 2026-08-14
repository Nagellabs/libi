import { NextResponse } from "next/server";
import { rejectTrackJob } from "@/lib/tracking/track-jobs";

export async function POST(req: Request) {
  const body = await req.json();
  const { jobId, token, message } = body ?? {};
  if (!jobId || !token) {
    return NextResponse.json({ error: "missing jobId/token" }, { status: 400 });
  }
  const ok = rejectTrackJob(jobId, token, String(message ?? "track error"));
  return NextResponse.json({ ok });
}
