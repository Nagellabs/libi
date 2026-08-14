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
  activeSceneDetails,
  assetSourceDetails,
  audioClipDetails,
  baseSceneDetails,
} from "@/lib/preview/scene-details";
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
    scenes: [],
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

describe("activeSceneDetails", () => {
  it("reports a downscaled proxy honestly (effective = proxy height)", () => {
    const f = file({ id: "f4k", mediaWidth: 3840, mediaHeight: 2160, proxyHeight: 1080, proxyFilename: "f4k-proxy.mp4" });
    const d = activeSceneDetails(videoComp("f4k"), 0, [f], "auto");
    expect(d.scene).toBeNull();
    expect(d.videos).toHaveLength(1);
    expect(d.videos[0]).toMatchObject({
      fileId: "f4k",
      fileName: "f4k.mp4",
      sourceWidth: 3840,
      sourceHeight: 2160,
      effectivePreviewHeight: 1080,
      isOverlay: true,
      matchesSource: false,
    });
  });

  it("reports a native-resolution preview as matching the source", () => {
    const f = file({ id: "f1080", mediaWidth: 1920, mediaHeight: 1080, proxyHeight: 1080, proxyFilename: "p.mp4" });
    const d = activeSceneDetails(videoComp("f1080"), 0, [f], "auto");
    expect(d.videos[0]).toMatchObject({ effectivePreviewHeight: 1080, matchesSource: true });
  });

  it("applies the 720p previewQuality decode cap on top of the proxy", () => {
    const f = file({ id: "f1080", mediaHeight: 1080, proxyHeight: 1080, proxyFilename: "p.mp4" });
    const d = activeSceneDetails(videoComp("f1080"), 0, [f], "720p");
    expect(d.videos[0]).toMatchObject({ effectivePreviewHeight: 720, matchesSource: false });
  });

  it("uses the source height when the proxy is not ready", () => {
    const f = file({ id: "f4k", mediaHeight: 2160, proxyStatus: "generating", proxyHeight: null });
    const d = activeSceneDetails(videoComp("f4k"), 0, [f], "auto");
    // Served = original (2160) → capped by auto (1080).
    expect(d.videos[0]).toMatchObject({ effectivePreviewHeight: 1080, matchesSource: false });
  });

  it("is honest about a legacy proxy with unknown encoded height", () => {
    const f = file({ id: "leg", mediaHeight: 1080, proxyStatus: "ready", proxyFilename: "leg-proxy.mp4", proxyHeight: null });
    const d = activeSceneDetails(videoComp("leg"), 0, [f], "auto");
    expect(d.videos[0]).toMatchObject({ effectivePreviewHeight: null, matchesSource: null });
  });

  it("returns scene info with no videos for a canvas scene", () => {
    const comp: Composition = {
      id: "c1", name: "Canvas", width: 1920, height: 1080, fps: 30,
      scenes: [{ id: "s1", name: "Intro card", type: "canvas", duration: 4, draw: () => {} }],
    };
    const d = activeSceneDetails(comp, 0, [file({ id: "x" })], "auto");
    expect(d.scene).toEqual({ name: "Intro card", type: "canvas", startSec: 0, endSec: 4 });
    expect(d.videos).toEqual([]);
  });

  it("includes video overlays active at the playhead, labeled as overlays", () => {
    const ov = videoOverlay({ fileId: "ovf", startTime: 1, duration: 2, z: 1 });
    const comp = videoComp("base", [ov]);
    const files = [
      file({ id: "base", mediaHeight: 1080, proxyHeight: 1080, proxyFilename: "b.mp4" }),
      file({ id: "ovf", mediaHeight: 720, proxyHeight: 720, proxyFilename: "o.mp4" }),
    ];
    // frame 45 = 1.5s → overlay active
    const at1_5 = activeSceneDetails(comp, 45, files, "auto");
    expect(at1_5.videos).toHaveLength(2);
    expect(at1_5.videos[1]).toMatchObject({ fileId: "ovf", overlayId: "ov1", isOverlay: true, effectivePreviewHeight: 720, matchesSource: true });
    // frame 0 = 0s → overlay inactive
    const at0 = activeSceneDetails(comp, 0, files, "auto");
    expect(at0.videos).toHaveLength(1);
  });

  it("skips a video whose file record is missing", () => {
    const d = activeSceneDetails(videoComp("missing"), 0, [file({ id: "other" })], "auto");
    expect(d.videos).toEqual([]);
  });

  it("returns empty for a null/empty composition", () => {
    expect(activeSceneDetails(null, 0, [file({ id: "x" })], "auto")).toEqual({ scene: null, videos: [] });
    const empty: Composition = { id: "c", name: "E", width: 1920, height: 1080, fps: 30, scenes: [] };
    expect(activeSceneDetails(empty, 0, [], "auto")).toEqual({ scene: null, videos: [] });
  });

  it("reports active video OVERLAYS when the comp has no scenes (fully-migrated piece)", () => {
    const comp: Composition = {
      id: "c1",
      name: "No scenes",
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [],
      overlays: [videoOverlay({ id: "vid-1", fileId: "f1", startTime: 0, duration: 10 })],
    };
    const files = [file({ id: "f1", mediaWidth: 1920, mediaHeight: 1080, proxyHeight: 1080, proxyFilename: "f1-proxy.mp4" })];
    const d = activeSceneDetails(comp, 0, files, "auto");
    expect(d.scene).toBeNull();
    expect(d.videos).toHaveLength(1);
    expect(d.videos[0]).toMatchObject({ fileId: "f1", overlayId: "vid-1", isOverlay: true, sourceWidth: 1920, sourceHeight: 1080 });
  });

  it("reports no videos when files are undefined", () => {
    const d = activeSceneDetails(videoComp("f1"), 0, undefined, "auto");
    expect(d.videos).toEqual([]);
  });

  it("resolves the correct CANVAS scene + time range across a cut", () => {
    const comp: Composition = {
      id: "c1", name: "Two", width: 1920, height: 1080, fps: 30,
      scenes: [
        { id: "s1", name: "A", type: "canvas", duration: 2, draw: () => {} },
        { id: "s2", name: "B", type: "canvas", duration: 2, draw: () => {} },
      ],
    };
    const d = activeSceneDetails(comp, 90, [], "auto"); // 3s → scene B
    expect(d.scene).toEqual({ name: "B", type: "canvas", startSec: 2, endSec: 4 });
  });
});

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

describe("baseSceneDetails", () => {
  it("describes a selected canvas scene by index (canvas scenes carry no video card)", () => {
    const composition = {
      width: 1920, height: 1080, fps: 30,
      scenes: [
        { id: "s1", name: "Clip", type: "canvas", duration: 2, drawFunction: "" },
        { id: "s2", name: "Card", type: "canvas", duration: 1, drawFunction: "" },
      ],
      overlays: [],
      audioClips: [],
    } as never;
    const files = [
      { id: "f1", name: "clip.mp4", filename: "clip.mp4", mediaWidth: 1920, mediaHeight: 1080, proxyStatus: "idle", proxyFilename: null, proxyHeight: null } as never,
    ];
    const r = baseSceneDetails(composition, 0, files, "auto");
    expect(r.scene).toMatchObject({ name: "Clip", type: "canvas", startSec: 0, endSec: 2 });
    expect(r.video).toBeNull();

    const r2 = baseSceneDetails(composition, 1, files, "auto");
    expect(r2.scene).toMatchObject({ name: "Card", type: "canvas", startSec: 2, endSec: 3 });
    expect(r2.video).toBeNull();
  });

  it("returns a null scene for an out-of-range index", () => {
    const composition = { width: 1, height: 1, fps: 30, scenes: [], overlays: [], audioClips: [] } as never;
    expect(baseSceneDetails(composition, 0, [], "auto").scene).toBeNull();
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
    scenes: [{ id: "s1", name: "Scene One", type: "video", duration: 4, fileId: "v1" }],
    overlays: [],
    audioClips: [
      { id: "a1", kind: "inline", fileId: "v1", startTime: 0, duration: 4, trimStart: 0, volume: 0.8, enabled: true, linkedSceneId: "s1", label: "scene audio" },
      { id: "a2", kind: "standalone", fileId: "m1", startTime: 1, duration: 2, trimStart: 0, volume: 1, enabled: false },
    ],
  } as never;
  const files = [
    file({ id: "v1", name: "clip.mp4", contentType: "video/mp4", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 4 }),
    file({ id: "m1", name: "music.wav", contentType: "audio/wav", mediaWidth: null, mediaHeight: null, mediaDuration: 30 }),
  ];

  it("inline clip resolves its linked scene name + the source VIDEO file", () => {
    const d = audioClipDetails(comp, "a1", files);
    expect(d?.clip.id).toBe("a1");
    expect(d?.linkedSceneName).toBe("Scene One");
    expect(d?.file).toMatchObject({ mediaKind: "video", sourceHeight: 1080 });
  });
  it("standalone clip has no linked scene and an audio source file", () => {
    const d = audioClipDetails(comp, "a2", files);
    expect(d?.linkedSceneName).toBeNull();
    expect(d?.file).toMatchObject({ mediaKind: "audio", fileName: "music.wav" });
  });
  it("returns null for an unknown clip id", () => {
    expect(audioClipDetails(comp, "nope", files)).toBeNull();
  });
});
