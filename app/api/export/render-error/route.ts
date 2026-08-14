import { NextResponse } from "next/server";
import { rejectRenderJob } from "@/lib/export/render-jobs";
import { exportLogger } from "@/lib/logger";

export async function POST(req: Request) {
  let body: { jobId?: string; token?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { jobId, token, message } = body;
  if (!jobId || !token || !message) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  const ok = rejectRenderJob(jobId, token, message);
  if (!ok) {
    return NextResponse.json({ error: "Job not found or already settled" }, { status: 404 });
  }
  exportLogger.warn({ event: "render_error", jobId, message }, "export.render_error");
  return NextResponse.json({ ok: true });
}
