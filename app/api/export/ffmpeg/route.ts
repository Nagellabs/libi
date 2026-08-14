import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { loadComposition } from "@/lib/composition/persistence";
import type { PersistedScene, CompositionManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import type { AudioClip, Composition, ExportSettings, Overlay } from "@/lib/engine/types";
import { classifyExportShape } from "@/lib/export/classifier";
import { attachOverlaySourceDims } from "@/lib/export/source-dims";
import { stripHiddenLayerArrays } from "@/lib/overlays/hidden";
import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";
import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import type { ExportBackend } from "@/lib/export/backend";
import { exportLogger } from "@/lib/logger";

interface Body {
  pieceId: string;
  compositionId?: string;
  shape: "stream-copy-trim" | "ffmpeg-overlay";
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
  if (!body.pieceId || !body.shape || !body.settings) {
    return NextResponse.json(
      { error: "Missing pieceId, shape, or settings" },
      { status: 400 },
    );
  }
  // Load composition from persistence — draft or snapshot depending on source.
  let manifest: CompositionManifest;
  let scenes: PersistedScene[];
  if (body.source === "snapshot") {
    const snap = await loadCurrentSnapshot(body.pieceId);
    if (!snap) {
      return NextResponse.json({ error: "No committed snapshot found for this piece" }, { status: 404 });
    }
    manifest = snap;
    scenes = snap.scenes ?? [];
  } else {
    ({ manifest, scenes } = await loadComposition(body.pieceId));
  }

  // Hidden layers (overlay.hidden — the persisted eye toggle) leave the export
  // entirely: strip them + their coupled inline audio BEFORE building/
  // classifying, so the second-pass check below grades the same filtered comp
  // the client classified (a hidden layer that changes the shape never 409s).
  const stripped = stripHiddenLayerArrays(manifest.overlays, manifest.audioClips);
  if (stripped.changed) {
    manifest = { ...manifest, overlays: stripped.overlays, audioClips: stripped.audioClips };
  }

  const comp = buildCompositionFromManifest(manifest, scenes);

  // Second-pass safety: confirm the client's shape still matches.
  // If the classifier disagrees (comp changed since client classified),
  // reject rather than running the wrong backend.
  const serverShape = classifyExportShape(comp);
  if (serverShape.tag !== body.shape) {
    return NextResponse.json(
      { error: `Composition shape changed: client=${body.shape}, server=${serverShape.tag}` },
      { status: 409 },
    );
  }

  // Output path — goes to a temp dir. We stream the bytes back and delete.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "libi-export-"));
  const outPath = path.join(tmpDir, `out.${body.settings.format}`);

  const backend: ExportBackend =
    body.shape === "stream-copy-trim"
      ? new StreamCopyTrimBackend()
      : new FfmpegOverlayBackend();

  const startAt = Date.now();
  exportLogger.info(
    {
      event: "start",
      backend: backend.name,
      pieceId: body.pieceId,
      outputPath: outPath,
    },
    "export.start",
  );

  try {
    const result = await backend.run({
      composition: comp,
      settings: body.settings,
      outputPath: outPath,
      signal: req.signal,
    });

    exportLogger.info(
      {
        event: "done",
        backend: backend.name,
        durationMs: Date.now() - startAt,
        outputDurationSeconds: result.duration,
      },
      "export.done",
    );

    const data = await fs.readFile(outPath);

    // Cleanup — fire and forget.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": `video/${body.settings.format}`,
        "Content-Length": data.length.toString(),
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
        durationMs: Date.now() - startAt,
        error: message,
      },
      `export.${kind}`,
    );

    // Cleanup any partial file + temp dir.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Hydrate a runtime `Composition` from persisted manifest + scenes for
 * classification purposes only. We do NOT reconstruct `scene.draw`
 * callables — they're strings on disk, and the server never executes
 * them. The classifier only reads discriminant fields (scene.type,
 * scene.trim, scene.fileId, and comp.overlays.length).
 *
 * Plan 4 added `manifest.overlays: PersistedOverlay[]`. `PersistedOverlay`
 * is structurally compatible with the runtime `Overlay` union — same
 * discriminant + fields — so the cast is shape-preserving. Runtime-only
 * assets (compiled draw functions, image elements) are attached by the
 * renderer hooks, not constructed here.
 *
 * `manifest.audioClips` is copied through as `comp.audioClips`. The
 * persisted `PersistedAudioClip` shape is structurally compatible with
 * the runtime `AudioClip` — `FfmpegOverlayBackend` reads `fileId` /
 * `startTime` / `duration` / `volume` / `enabled` / `linkedSceneId`.
 */
function buildCompositionFromManifest(
  manifest: CompositionManifest,
  scenes: PersistedScene[],
): Composition {
  return {
    id: "composition-1",
    name: "Export",
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    scenes: scenes.map((s) => {
      return {
        id: s.id,
        name: s.name,
        type: "canvas" as const,
        duration: s.duration,
        draw: () => {},
      };
    }),
    // Source pixel dims for video overlays come from the `files` table — the
    // classifier needs them to know whether `-c copy` would preserve framing,
    // and the CLIENT already has them via `buildComposition`. Without this the
    // two would disagree and the second-pass check above would 409.
    overlays: attachOverlaySourceDims((manifest.overlays ?? []) as Overlay[]),
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
  };
}
