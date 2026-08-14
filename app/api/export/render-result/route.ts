import { NextResponse } from "next/server";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRenderJob, resolveRenderJob } from "@/lib/export/render-jobs";
import { exportLogger } from "@/lib/logger";

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: "Expected multipart form" }, { status: 400 });
  }

  const jobId = String(form.get("jobId") ?? "");
  const token = String(form.get("token") ?? "");
  const durationSecondsRaw = form.get("durationSeconds");
  const file = form.get("file");

  if (!jobId || !token || typeof durationSecondsRaw !== "string" || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const entry = getRenderJob(jobId, token);
  if (!entry) {
    return NextResponse.json({ error: "Job not found or token invalid" }, { status: 404 });
  }

  const durationSeconds = Number.parseFloat(durationSecondsRaw);
  if (!Number.isFinite(durationSeconds)) {
    return NextResponse.json({ error: "Invalid durationSeconds" }, { status: 400 });
  }

  const dir = await mkdtemp(join(tmpdir(), "libi-render-"));
  const ext = entry.settings.format === "webm" ? "webm" : "mp4";
  const tempFilePath = join(dir, `out.${ext}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(tempFilePath, bytes);

  const ok = resolveRenderJob(jobId, token, { tempFilePath, durationSeconds });
  if (!ok) {
    return NextResponse.json({ error: "Job already settled" }, { status: 409 });
  }

  exportLogger.info(
    { event: "render_result", jobId, pieceId: entry.pieceId, bytes: bytes.length, durationSeconds },
    "export.render_result",
  );

  return NextResponse.json({ ok: true });
}
