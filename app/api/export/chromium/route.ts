import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ChromiumRenderBackend } from "@/lib/export/backends/chromium-render";
import { classifyExportShape } from "@/lib/export/classifier";
import { attachOverlaySourceDims } from "@/lib/export/source-dims";
import { stripHiddenLayerArrays } from "@/lib/overlays/hidden";
import { getCompositionFrames } from "@/lib/engine/renderer";
import { loadComposition } from "@/lib/composition/persistence";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import type {
  AudioClip,
  Composition,
  ExportSettings,
  Overlay,
} from "@/lib/engine/types";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import type { RenderPayload } from "@/lib/export/render-jobs";
import { exportLogger } from "@/lib/logger";

interface Body {
  pieceId: string;
  settings: ExportSettings;
  source?: "draft" | "snapshot";
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.pieceId || !body.settings) {
    return NextResponse.json(
      { error: "Missing pieceId or settings" },
      { status: 400 },
    );
  }

  let manifest: CompositionManifest;
  if (body.source === "snapshot") {
    const snap = await loadCurrentSnapshot(body.pieceId);
    if (!snap) {
      return NextResponse.json({ error: "No committed snapshot found for this piece" }, { status: 404 });
    }
    manifest = snap;
  } else {
    ({ manifest } = await loadComposition(body.pieceId));
  }

  // Hidden layers (overlay.hidden — the persisted eye toggle) leave the export
  // entirely: strip them + their coupled inline audio BEFORE building/
  // classifying — the render payload below reads the same filtered arrays, so
  // the hidden layer neither renders in the chromium pass nor sounds in the
  // audio mux.
  const stripped = stripHiddenLayerArrays(manifest.overlays, manifest.audioClips);
  if (stripped.changed) {
    manifest = { ...manifest, overlays: stripped.overlays, audioClips: stripped.audioClips };
  }

  const composition = buildCompositionFromManifest(manifest);

  // Second-pass safety: confirm the composition still classifies as
  // chromium-render. If it changed between client classification and now,
  // reject so the router can re-dispatch to the correct backend.
  const serverShape = classifyExportShape(composition);
  if (serverShape.tag !== "chromium-render") {
    return NextResponse.json(
      {
        error: `Composition shape is ${serverShape.tag}, expected chromium-render`,
      },
      { status: 409 },
    );
  }

  // Build the render payload: raw scene data + files the render page needs
  // to hydrate a Composition via buildComposition(). We cannot pass a hydrated
  // Composition across the /api/export/render-job/[jobId] boundary — compiled
  // draw functions don't survive JSON.stringify, so we must re-hydrate client-side.
  const payload: RenderPayload = {
    // Source pixel dims for video overlays come from the `files` table — the
    // classifier needs them to know whether `-c copy` would preserve framing.
    // Without this, this route's second-pass classifier sees dims-unknown for
    // every base and can disagree with the client (and with the ffmpeg route,
    // which already hydrates them), turning a correct request into a 409.
    overlays: attachOverlaySourceDims((manifest.overlays ?? []) as Overlay[]),
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    files: getDb()
      .select()
      .from(filesTable)
      .where(eq(filesTable.pieceId, body.pieceId))
      .all(),
    // The runner splits this into chunks; a chunk's stall watchdog + progress
    // are per-chunk, so this is only used for chunk planning + aggregate progress.
    totalFrames: getCompositionFrames(composition),
  };

  const backend = new ChromiumRenderBackend();
  const startAt = Date.now();
  exportLogger.info(
    { event: "start", backend: backend.name, pieceId: body.pieceId },
    "export.start",
  );

  try {
    const result = await backend.run({
      pieceId: body.pieceId,
      composition, // unused by chromium-render but required by ExportContext
      payload,
      settings: body.settings,
      onProgress: () => {},
      signal: req.signal,
    });

    exportLogger.info(
      {
        event: "done",
        backend: backend.name,
        pieceId: body.pieceId,
        durationMs: Date.now() - startAt,
        outputDurationSeconds: result.duration,
      },
      "export.done",
    );

    const buf = Buffer.from(await result.blob.arrayBuffer());
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": result.blob.type,
        "Content-Length": String(buf.length),
        "X-Export-Backend": backend.name,
        "X-Export-Duration-Seconds": String(result.duration),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = req.signal.aborted ? "cancel" : "fail";
    exportLogger.error(
      {
        event: kind,
        backend: backend.name,
        pieceId: body.pieceId,
        durationMs: Date.now() - startAt,
        error: message,
      },
      `export.${kind}`,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Hydrate a stub `Composition` from persisted manifest + scenes purely for the
 * classifier. The classifier only inspects discriminant fields (scene.type,
 * overlays[], audioClips[]) so we don't need real draw callables or video URLs.
 *
 * The actual render pipeline uses `RenderPayload` (raw scene data) and hydrates
 * via `buildComposition()` inside the hidden render window — see above.
 */
function buildCompositionFromManifest(
  manifest: CompositionManifest,
): Composition {
  return {
    id: "composition-1",
    name: "Export",
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    // Source pixel dims for video overlays come from the `files` table — the
    // classifier needs them to know whether `-c copy` would preserve framing.
    // Without this, this route's second-pass classifier sees dims-unknown for
    // every base and can disagree with the client (and with the ffmpeg route,
    // which already hydrates them), turning a correct request into a 409.
    overlays: attachOverlaySourceDims((manifest.overlays ?? []) as Overlay[]),
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
  };
}
