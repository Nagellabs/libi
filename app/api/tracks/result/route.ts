import { NextResponse } from "next/server";
import { resolveTrackJob } from "@/lib/tracking/track-jobs";
import { serverLogger as logger } from "@/lib/logger";

export async function POST(req: Request) {
  const body = await req.json();
  const { jobId, token, samples, framerate, method } = body ?? {};
  if (!jobId || !token || !Array.isArray(samples)) {
    return NextResponse.json(
      { error: "missing jobId/token/samples" },
      { status: 400 },
    );
  }
  const ok = resolveTrackJob(jobId, token, { samples, framerate, method });
  if (!ok) {
    return NextResponse.json(
      { error: "job not found / settled / wrong token" },
      { status: 404 },
    );
  }
  logger.info({ jobId, sampleCount: samples.length }, "tracking.result.received");
  return NextResponse.json({ ok: true });
}
