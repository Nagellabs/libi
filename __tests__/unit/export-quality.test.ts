import { describe, it, expect } from "vitest";
import {
  resolveExportSettings,
  resolveExportSettingsWithTier,
  isUpscaling,
  resolveOutputDimensions,
  hasGraphicsOverlays,
  fitWithin,
  usesSocialFit,
  SOCIAL_FIT,
  SOCIAL_DEFAULT_QUALITY,
  SOCIAL_DEFAULT_GRAPHICS_QUALITY,
} from "@/lib/export/quality";
import type { Overlay } from "@/lib/engine/types";
import type { TrackedContent } from "@/lib/tracking/types";

describe("resolveExportSettings", () => {
  it("uses source dimensions when quality is 'source'", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "source",
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    // Below-1080p sources get the 4 Mbps floor.
    expect(s.bitrate).toBeGreaterThanOrEqual(4_000_000);
  });

  it("applies the 1080p preset", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "1080p",
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(s.bitrate).toBe(8_000_000);
  });

  it("applies the 4k preset with a ~32 Mbps bitrate", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "4k",
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.width).toBe(3840);
    expect(s.height).toBe(2160);
    expect(s.bitrate).toBeGreaterThanOrEqual(30_000_000);
    expect(s.bitrate).toBeLessThanOrEqual(36_000_000);
  });

  it("rounds dimensions down to even (yuv420p requirement)", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "custom",
      customWidth: 1281,
      customHeight: 723,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.width).toBe(1280);
    expect(s.height).toBe(722);
  });

  it("custom requires both customWidth and customHeight", () => {
    expect(() =>
      resolveExportSettings({
        format: "mp4",
        codec: "avc",
        fps: 30,
        quality: "custom",
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toThrow();
  });

  it("defaults audioBitrate to 320_000 for MP4 (AAC)", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "source",
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.audioBitrate).toBe(320_000);
  });

  // libopus accepts at most 256 kbps PER CHANNEL: 320k on a mono source is
  // "Could not open encoder" and the whole WebM export fails (QA N2).
  it("defaults audioBitrate to 256_000 for WebM (Opus) — valid for mono and stereo", () => {
    const s = resolveExportSettings({
      format: "webm",
      codec: "vp9",
      fps: 30,
      quality: "source",
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.audioBitrate).toBe(256_000);
  });

  it("clamps an explicit WebM audioBitrate to the Opus mono ceiling, leaves MP4 alone", () => {
    const base = { fps: 30, quality: "source" as const, sourceWidth: 1920, sourceHeight: 1080, audioBitrate: 320_000 };
    expect(resolveExportSettings({ ...base, format: "webm", codec: "vp9" }).audioBitrate).toBe(256_000);
    expect(resolveExportSettings({ ...base, format: "mp4", codec: "avc" }).audioBitrate).toBe(320_000);
    expect(resolveExportSettings({ ...base, audioBitrate: 128_000, format: "webm", codec: "vp9" }).audioBitrate).toBe(128_000);
  });

  it("defaults graphicsQuality to '4k' and echoes it in the result", () => {
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "source",
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(s.graphicsQuality).toBe("4k");
  });

  it("hasGraphics defaults to false — omitting it keeps pre-graphics-split behaviour", () => {
    // A graphics-capable piece (portrait) at media 'source' with the 4k
    // graphics default would upscale to 4k IF hasGraphics were true. Since
    // existing callers never pass hasGraphics, it must stay false and the
    // media dimensions must pass straight through.
    const s = resolveExportSettings({
      format: "mp4",
      codec: "avc",
      fps: 30,
      quality: "source",
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect([s.width, s.height]).toEqual([1080, 1920]);
  });
});

describe("resolveOutputDimensions", () => {
  it("raises media 'source' to the 4k graphics tier when the piece has graphics", () => {
    const d = resolveOutputDimensions({
      quality: "source",
      graphicsQuality: "4k",
      hasGraphics: true,
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect(d).toEqual({ width: 2160, height: 3840, drivenBy: "graphics" });
  });

  it("stays at media 'source' dims when the piece has no graphics", () => {
    const d = resolveOutputDimensions({
      quality: "source",
      graphicsQuality: "4k",
      hasGraphics: false,
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect(d).toEqual({ width: 1080, height: 1920, drivenBy: "media" });
  });

  it("keeps the larger media tier when media '4k' beats graphics '1080p'", () => {
    const d = resolveOutputDimensions({
      quality: "4k",
      graphicsQuality: "1080p",
      hasGraphics: true,
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect(d).toEqual({ width: 2160, height: 3840, drivenBy: "media" });
  });

  it("keeps media 'source' at a large composition even against a smaller graphics tier", () => {
    const d = resolveOutputDimensions({
      quality: "source",
      graphicsQuality: "1080p",
      hasGraphics: true,
      sourceWidth: 3840,
      sourceHeight: 2160,
    });
    expect(d).toEqual({ width: 3840, height: 2160, drivenBy: "media" });
  });

  it("custom ignores graphics entirely, even when hasGraphics is true", () => {
    const d = resolveOutputDimensions({
      quality: "custom",
      graphicsQuality: "4k",
      hasGraphics: true,
      sourceWidth: 1920,
      sourceHeight: 1080,
      customWidth: 1000,
      customHeight: 500,
    });
    expect(d).toEqual({ width: 1000, height: 500, drivenBy: "media" });
  });

  it("custom still requires both dimensions", () => {
    expect(() =>
      resolveOutputDimensions({
        quality: "custom",
        graphicsQuality: "4k",
        hasGraphics: false,
        sourceWidth: 1920,
        sourceHeight: 1080,
      }),
    ).toThrow(/custom quality requires/);
  });
});

/** Minimal BaseOverlay fields shared by every fixture below — only what
 *  hasGraphicsOverlays actually reads (kind, and content.kind for tracked)
 *  matters, but the type wants a fully-shaped Overlay. */
const BASE = { id: "o1", startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 } };

function tracked(content: TrackedContent): Overlay {
  return {
    ...BASE,
    kind: "tracked",
    trackId: "t1",
    content,
    fit: "rect",
    scale: 1,
    smoothing: "linear",
  } as Overlay;
}

describe("hasGraphicsOverlays", () => {
  it("is false for undefined/empty overlays", () => {
    expect(hasGraphicsOverlays(undefined)).toBe(false);
    expect(hasGraphicsOverlays([])).toBe(false);
  });

  it("is true for a text overlay", () => {
    const o = { ...BASE, kind: "text", content: "hi", font: "16px Inter", color: "#fff", align: "left" } as Overlay;
    expect(hasGraphicsOverlays([o])).toBe(true);
  });

  it("is true for a code overlay", () => {
    const o = { ...BASE, kind: "code", drawFunction: "" } as Overlay;
    expect(hasGraphicsOverlays([o])).toBe(true);
  });

  it("is true for a three overlay", () => {
    const o = { ...BASE, kind: "three", sceneFunction: "" } as Overlay;
    expect(hasGraphicsOverlays([o])).toBe(true);
  });

  it("is true for a tracked text overlay", () => {
    const o = tracked({ kind: "text", content: "hi", font: "16px Inter", color: "#fff", align: "left" });
    expect(hasGraphicsOverlays([o])).toBe(true);
  });

  it("is false for an image overlay", () => {
    const o = { ...BASE, kind: "image", fileId: "f1" } as Overlay;
    expect(hasGraphicsOverlays([o])).toBe(false);
  });

  it("is false for a video overlay", () => {
    const o = { ...BASE, kind: "video", fileId: "f1" } as Overlay;
    expect(hasGraphicsOverlays([o])).toBe(false);
  });

  it("is false for a tracked image overlay", () => {
    const o = tracked({ kind: "image", fileId: "f1" });
    expect(hasGraphicsOverlays([o])).toBe(false);
  });

  it("is false for a tracked effect overlay", () => {
    const o = tracked({ kind: "effect", op: "blur" });
    expect(hasGraphicsOverlays([o])).toBe(false);
  });

  it("is false when the only graphics overlay is hidden (every export strips it)", () => {
    expect(hasGraphicsOverlays([{ kind: "video" }, { kind: "text", hidden: true }])).toBe(false);
  });

  it("a hidden text beside a visible code overlay is still true", () => {
    expect(hasGraphicsOverlays([{ kind: "text", hidden: true }, { kind: "code" }])).toBe(true);
  });
});

describe("isUpscaling", () => {
  it("is true when target dimensions exceed source", () => {
    const s = resolveExportSettings({
      format: "mp4", codec: "avc", fps: 30, quality: "4k",
      sourceWidth: 1920, sourceHeight: 1080,
    });
    expect(isUpscaling(s, 1920, 1080)).toBe(true);
  });
  it("is false at source", () => {
    const s = resolveExportSettings({
      format: "mp4", codec: "avc", fps: 30, quality: "source",
      sourceWidth: 1920, sourceHeight: 1080,
    });
    expect(isUpscaling(s, 1920, 1080)).toBe(false);
  });
});

describe("social fit (agent-speed A4)", () => {
  it("fitWithin scales a 4K portrait frame to 1080×1920 and a 4K landscape one to 1920×1080", () => {
    expect(fitWithin(2160, 3840, SOCIAL_FIT)).toEqual({ width: 1080, height: 1920 });
    expect(fitWithin(3840, 2160, SOCIAL_FIT)).toEqual({ width: 1920, height: 1080 });
  });

  it("fitWithin keeps the piece's aspect: square, 4:5 and a tall phone frame", () => {
    expect(fitWithin(2160, 2160, SOCIAL_FIT)).toEqual({ width: 1080, height: 1080 });
    expect(fitWithin(2160, 2700, SOCIAL_FIT)).toEqual({ width: 1080, height: 1350 });
    // 9:20: the 1920 long edge binds, not the 1080 short one.
    const tall = fitWithin(1080, 2400, SOCIAL_FIT);
    expect(tall.height).toBe(1920);
    expect(tall.width).toBe(864);
  });

  it("fitWithin never upscales and keeps dimensions even", () => {
    expect(fitWithin(720, 1280, SOCIAL_FIT)).toEqual({ width: 720, height: 1280 });
    expect(fitWithin(1081, 1921, SOCIAL_FIT).width % 2).toBe(0);
    expect(fitWithin(1081, 1921, SOCIAL_FIT).height % 2).toBe(0);
  });

  it("a graphics piece resolved at the social tiers and fitted comes out 1080×1920, not 4K", () => {
    const { settings } = resolveExportSettingsWithTier({
      format: "mp4", codec: "avc", fps: 30,
      quality: SOCIAL_DEFAULT_QUALITY, graphicsQuality: SOCIAL_DEFAULT_GRAPHICS_QUALITY, hasGraphics: true,
      sourceWidth: 2160, sourceHeight: 3840, fitWithin: SOCIAL_FIT,
    });
    expect([settings.width, settings.height]).toEqual([1080, 1920]);
    // The same piece at the stored defaults is the 4K the plan retires for social.
    const full = resolveExportSettingsWithTier({
      format: "mp4", codec: "avc", fps: 30, quality: "source", graphicsQuality: "4k", hasGraphics: true,
      sourceWidth: 2160, sourceHeight: 3840,
    }).settings;
    expect([full.width, full.height]).toEqual([2160, 3840]);
  });

  it("an uncapped resolve is unchanged", () => {
    const a = resolveOutputDimensions({ quality: "4k", graphicsQuality: "4k", hasGraphics: false, sourceWidth: 1920, sourceHeight: 1080 });
    expect([a.width, a.height]).toEqual([3840, 2160]);
  });

  it("usesSocialFit: social with no size named; any named size opts out", () => {
    expect(usesSocialFit({ purpose: "social" })).toBe(true);
    expect(usesSocialFit({ purpose: "personal" })).toBe(false);
    expect(usesSocialFit({})).toBe(false);
    expect(usesSocialFit({ purpose: "social", quality: "4k" })).toBe(false);
    expect(usesSocialFit({ purpose: "social", quality: "source" })).toBe(false);
    expect(usesSocialFit({ purpose: "social", graphicsQuality: "4k" })).toBe(false);
    expect(usesSocialFit({ purpose: "social", customWidth: 3840, customHeight: 2160 })).toBe(false);
  });
});
