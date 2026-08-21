/**
 * Unit: activeSceneDetails — resolves the scene at the playhead to scene info
 * + per-video resolution facts (base scene video + active video overlays),
 * honest about both the proxy substitution and the previewQuality decode cap.
 * Replaces the old activeSceneProxyDims (preview-proxy-badge) for the
 * timeline preview; also hosts the isProxyDownscaled coverage that lived in
 * the deleted active-scene-proxy-dims.test.ts (the asset viewer still uses it).
 */
import { describe, it, expect } from "vitest";
import {
  assetSourceDetails,
  audioClipDetails,
} from "@/lib/preview/layer-details";
import { isProxyDownscaled } from "@/components/preview/preview-proxy-badge";
import type { Composition, VideoOverlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

function file(partial: Partial<FileRecord> & { id: string }): FileRecord {
  return {
    id: partial.id,
    pieceId: partial.pieceId ?? "p1",
    folderId: partial.folderId ?? null,
    filename: partial.filename ?? `${partial.id}.mp4`,
    name: partial.name ?? `${partial.id}.mp4`,
    description: partial.description ?? "",
    type: partial.type ?? "video",
    storagePath: partial.storagePath ?? `/storage/${partial.id}.mp4`,
    contentType: partial.contentType ?? "video/mp4",
    size: partial.size ?? 1000,
    mediaDuration: partial.mediaDuration ?? 4,
    mediaWidth: partial.mediaWidth ?? null,
    mediaHeight: partial.mediaHeight ?? null,
    hasAudio: partial.hasAudio ?? null,
    proxyFilename: partial.proxyFilename ?? null,
    proxyStatus: partial.proxyStatus ?? "ready",
    proxyGeneratedAt: partial.proxyGeneratedAt ?? null,
    proxyHeight: partial.proxyHeight ?? null,
    falUploadedUrl: partial.falUploadedUrl ?? null,
    notes: partial.notes ?? null,
    aiGeneration: partial.aiGeneration ?? null,
    createdAt: partial.createdAt ?? new Date(),
  } as FileRecord;
}

/**
 * A scene-less composition whose base is a full-frame video OVERLAY — the shape
 * every piece has since video scenes were retired. `d.scene` is therefore null
 * (there is genuinely no base scene to describe) and the base video shows up in
 * `d.videos` as an overlay.
 */
function videoComp(fileId: string, extraOverlays: VideoOverlay[] = []): Composition {
  return {
    id: "c1",
    name: "Test",
    width: 1920,
    height: 1080,
    fps: 30,
    overlays: [
      {
        id: "base",
        kind: "video",
        fileId,
        videoUrl: `/api/files/by-id/${fileId}/content`,
        startTime: 0,
        duration: 4,
        z: 0,
        opacity: 1,
        fit: "cover",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      ...extraOverlays,
    ],
  };
}

function videoOverlay(partial: Partial<VideoOverlay> & { fileId: string }): VideoOverlay {
  return {
    id: partial.id ?? "ov1",
    kind: "video",
    fileId: partial.fileId,
    startTime: partial.startTime ?? 1,
    duration: partial.duration ?? 2,
    z: partial.z ?? 0,
    rect: partial.rect ?? { x: 0, y: 0, width: 640, height: 360 },
    opacity: partial.opacity ?? 1,
    trim: partial.trim,
  };
}


// Moved coverage: the asset viewer (asset-media-view.tsx) still uses
// isProxyDownscaled + PreviewProxyBadge; the old test file that covered it
// (active-scene-proxy-dims.test.ts) is deleted with activeSceneProxyDims.
describe("isProxyDownscaled (asset-viewer badge predicate)", () => {
  it("is true only when both heights are known and proxy < original", () => {
    expect(isProxyDownscaled(1080, 2160)).toBe(true);
    expect(isProxyDownscaled(1080, 1080)).toBe(false);
    expect(isProxyDownscaled(null, 2160)).toBe(false);
    expect(isProxyDownscaled(1080, null)).toBe(false);
    expect(isProxyDownscaled(null, null)).toBe(false);
  });
});


describe("assetSourceDetails", () => {
  it("reports name, media kind, dims, and duration for a video file", () => {
    const d = assetSourceDetails("v1", [
      file({ id: "v1", name: "clip.mp4", contentType: "video/mp4", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 5 }),
    ]);
    expect(d).toMatchObject({
      fileId: "v1",
      fileName: "clip.mp4",
      mediaKind: "video",
      sourceWidth: 1920,
      sourceHeight: 1080,
      durationSec: 5,
    });
  });
  it("classifies an audio file as media kind 'audio' with null dims", () => {
    const d = assetSourceDetails("a1", [
      file({ id: "a1", name: "vo.mp3", contentType: "audio/mpeg", mediaWidth: null, mediaHeight: null, mediaDuration: 3 }),
    ]);
    expect(d?.mediaKind).toBe("audio");
    expect(d?.sourceWidth).toBeNull();
    expect(d?.durationSec).toBe(3);
  });
  it("returns null when the file isn't loaded", () => {
    expect(assetSourceDetails("missing", [])).toBeNull();
    expect(assetSourceDetails("missing", undefined)).toBeNull();
  });
});

describe("audioClipDetails", () => {
  const comp = {
    width: 1920, height: 1080, fps: 30,
    overlays: [],
    audioClips: [
      { id: "a1", kind: "inline", fileId: "v1", startTime: 0, duration: 4, trimStart: 0, volume: 0.8, enabled: true, label: "scene audio" },
      { id: "a2", kind: "standalone", fileId: "m1", startTime: 1, duration: 2, trimStart: 0, volume: 1, enabled: false },
    ],
  } as never;
  const files = [
    file({ id: "v1", name: "clip.mp4", contentType: "video/mp4", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 4 }),
    file({ id: "m1", name: "music.wav", contentType: "audio/wav", mediaWidth: null, mediaHeight: null, mediaDuration: 30 }),
  ];

  it("returns null for an unknown clip id", () => {
    expect(audioClipDetails(comp, "nope", files)).toBeNull();
  });
});
