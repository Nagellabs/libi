import { describe, expect, it } from "vitest";
import { assetOverlaySegments } from "@/lib/export/overlay-filter";

const rect = { x: 10, y: 20, width: 640, height: 360 };

describe("assetOverlaySegments fidelity", () => {
  it("applies partial opacity via a format+colorchannelmixer alpha stage", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect, opacity: 0.5 } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).toMatch(/colorchannelmixer=aa=0\.5/);
  });

  it("omits the alpha stage at full opacity (no needless filter)", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect, opacity: 1 } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).not.toMatch(/colorchannelmixer/);
  });

  it("omits the alpha stage when opacity is unset (defaults to full)", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).not.toMatch(/colorchannelmixer/);
  });

  it("cover-fit crops to the rect instead of letterboxing", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect, fit: "cover" } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).toMatch(/force_original_aspect_ratio=increase/);
    expect(out).toMatch(/crop=640:360/);
  });

  it("contain-fit keeps the decrease behavior", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect, fit: "contain" } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).toMatch(/force_original_aspect_ratio=decrease/);
    expect(out).not.toMatch(/crop=/);
  });

  // Fit DEFAULT (no explicit `fit`) must mirror `drawOverlayContent2D`
  // (lib/engine/overlay-renderer.ts): a video overlay defaults to "cover" (a
  // video dropped in full-frame should fill like a base scene, not letterbox);
  // an image overlay has no `fit` field at all and always renders contain
  // (fitRect) — so the default here must key off `kind`, not just `?? "contain"`.
  it("a video overlay with NO explicit fit defaults to cover (matches the canvas renderer)", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).toMatch(/force_original_aspect_ratio=increase/);
    expect(out).toMatch(/crop=640:360/);
  });

  it("an image overlay (no fit field at all) always renders contain", () => {
    const out = assetOverlaySegments(
      { kind: "image", startTime: 0, duration: 5, rect } as never,
      1, "base", "out", "k", 0,
    ).join("\n");
    expect(out).toMatch(/force_original_aspect_ratio=decrease/);
    expect(out).not.toMatch(/crop=/);
  });

  it("scales rect + position by the composition→target scale factor", () => {
    const out = assetOverlaySegments(
      { kind: "video", startTime: 0, duration: 5, rect, fit: "cover" } as never,
      1, "base", "out", "k", 0, 2,
    ).join("\n");
    // rect scaled 2x: width 640→1280, height 360→720, x 10→20, y 20→40.
    expect(out).toMatch(/scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720/);
    expect(out).toMatch(/overlay=20:40:/);
  });
});
