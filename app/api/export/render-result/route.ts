import { NextResponse } from "next/server";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRenderJob, resolveRenderJob } from "@/lib/export/render-jobs";
import { exportLogger } from "@/lib/logger";
import { hasManifest, loadManifest } from "@/lib/composition/persistence";
import { bodyHashesOf } from "@/lib/render/body-hashes";
import { applyExportDiagnostics, parseExportDiagnosticsReport } from "@/lib/render/render-diagnostics-store";
import { evaluateRequestOrigin } from "@/lib/security/request-guard";

export async function POST(req: Request) {
  // This route sits outside proxy.ts's matcher (multipart size — see the note
  // there), so the CSRF/rebinding guard has to run here by hand, in addition to
  // the per-job token below (spec §4.10). It runs before the body is read, so a
  // refused request costs no multipart parse.
  const verdict = evaluateRequestOrigin({
    method: req.method,
    secFetchSite: req.headers.get("sec-fetch-site"),
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    serverHost: req.headers.get("host"),
  });
  if (!verdict.allow) {
    return NextResponse.json({ error: "forbidden_cross_origin", reason: verdict.reason }, { status: 403 });
  }

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

  // Body-layer diagnostics from the sandboxed runtime (spec §4.7): failures,
  // unattributed runtime errors and the frames each body rendered cleanly.
  // Applied BEFORE the job resolves, so an agent that reads
  // libi.get_piece_state right after libi.render_overlay_frames returns sees
  // them. Judged against the piece's CURRENT draft bodies — a pass over an
  // older body (a snapshot render, an edit mid-render) files nothing and
  // clears nothing. Informational: never fails the postback.
  const renderDiagnosticsRaw = form.get("renderDiagnostics");
  if (typeof renderDiagnosticsRaw === "string") {
    try {
      const report = parseExportDiagnosticsReport(JSON.parse(renderDiagnosticsRaw));
      // A piece deleted while it rendered has no manifest: `loadManifest` would
      // WRITE an empty snapshot into an orphan piece dir, and the merge would
      // bring back the store key `clearRenderDiagnostics` removed.
      if (report && !(await hasManifest(entry.pieceId))) {
        exportLogger.info({ event: "render_diagnostics_piece_gone", jobId, pieceId: entry.pieceId }, "export.render_diagnostics_piece_gone");
      } else if (report) {
        const manifest = await loadManifest(entry.pieceId);
        const hashes = await bodyHashesOf(manifest.overlays ?? []);
        applyExportDiagnostics(entry.pieceId, report, (id) => hashes.get(id));
        exportLogger.info(
          {
            event: "render_diagnostics",
            jobId,
            pieceId: entry.pieceId,
            failures: report.diagnostics.map((d) => ({ overlayId: d.overlayId, phase: d.phase, time: d.time })),
            unattributed: report.unattributed.length,
            clean: report.clean.length,
          },
          "export.render_diagnostics",
        );
      }
    } catch (err) {
      exportLogger.warn({ event: "render_diagnostics_rejected", jobId, err: (err as Error).message }, "export.render_diagnostics_rejected");
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
