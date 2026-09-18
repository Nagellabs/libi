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

  // Overlays the render page's exportVideo() skipped because their draw threw
  // (QA 2026-09-18 B1). Best-effort parse: malformed/absent JSON must never
  // fail the postback — the render itself succeeded, this is purely
  // informational. Loosely shape-checked (array of {id, message} strings)
  // since the only writer is our own render-entry.ts bundle.
  let droppedOverlays: Array<{ id: string; message: string }> | undefined;
  const droppedOverlaysRaw = form.get("droppedOverlays");
  if (typeof droppedOverlaysRaw === "string") {
    try {
      const parsed: unknown = JSON.parse(droppedOverlaysRaw);
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (d): d is { id: string; message: string } =>
            typeof d === "object" && d !== null &&
            typeof (d as { id?: unknown }).id === "string" &&
            typeof (d as { message?: unknown }).message === "string",
        )
      ) {
        droppedOverlays = parsed;
      }
    } catch {
      // Malformed — ignore, keep droppedOverlays undefined.
    }
  }

  // Uploaded fonts the render page couldn't load (QA recheck N5), with why —
  // informational like droppedOverlays: anything malformed is dropped.
  let unloadedFonts: Array<{ fontFileId: string; reason: string }> | undefined;
  const unloadedFontsRaw = form.get("unloadedFonts");
  if (typeof unloadedFontsRaw === "string") {
    try {
      const parsed: unknown = JSON.parse(unloadedFontsRaw);
      if (Array.isArray(parsed)) {
        unloadedFonts = parsed.filter(
          (x): x is { fontFileId: string; reason: string } =>
            typeof x === "object" && x !== null &&
            typeof (x as { fontFileId?: unknown }).fontFileId === "string" &&
            typeof (x as { reason?: unknown }).reason === "string",
        );
      }
    } catch {
      // Malformed — ignore.
    }
  }

  const dir = await mkdtemp(join(tmpdir(), "libi-render-"));
  const ext = entry.settings.format === "webm" ? "webm" : "mp4";
  const tempFilePath = join(dir, `out.${ext}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(tempFilePath, bytes);

  const ok = resolveRenderJob(jobId, token, {
    tempFilePath,
    durationSeconds,
    ...(droppedOverlays?.length ? { droppedOverlays } : {}),
    ...(unloadedFonts?.length ? { unloadedFonts } : {}),
  });
  if (!ok) {
    return NextResponse.json({ error: "Job already settled" }, { status: 409 });
  }

  exportLogger.info(
    { event: "render_result", jobId, pieceId: entry.pieceId, bytes: bytes.length, durationSeconds },
    "export.render_result",
  );

  return NextResponse.json({ ok: true });
}
