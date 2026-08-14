import { describe, it, expect } from "vitest";
import type { ImageOverlay } from "@/lib/engine/types";
import { overlayAtPlayhead } from "@/lib/overlays/display-overlay";

function baseImageOverlay(partial: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "ov1",
    kind: "image",
    startTime: 2,
    duration: 4, // window [2, 6) seconds
    z: 0,
    rect: { x: 100, y: 100, width: 200, height: 150 },
    opacity: 1,
    fileId: "file1",
    ...partial,
  };
}

/** A keyframed overlay: rect.x 100→500 (t 0→1), opacity 1→0 (t 0→1). */
function keyframedOverlay(): ImageOverlay {
  return baseImageOverlay({
    keyframes: {
      rect: {
        keyframes: [
          { t: 0, value: { x: 100, y: 100, width: 200, height: 150 } },
          { t: 1, value: { x: 500, y: 100, width: 200, height: 150 } },
        ],
      },
      opacity: {
        keyframes: [
          { t: 0, value: 1 },
          { t: 1, value: 0 },
        ],
      },
    },
  });
}

const FPS = 30;

describe("overlayAtPlayhead", () => {
  it("returns null for a null overlay", () => {
    expect(overlayAtPlayhead(null, 1, FPS)).toBeNull();
  });

  it("returns the SAME reference for a non-keyframed overlay (identity, no new object)", () => {
    const ov = baseImageOverlay();
    // Even mid-window, a non-keyframed overlay is returned untouched.
    expect(overlayAtPlayhead(ov, 4, FPS)).toBe(ov);
  });

  it("resolves rect + opacity at the playhead midpoint of the window", () => {
    const ov = keyframedOverlay();
    // Window is [2, 6): playhead at 4s → local t = (4-2)/4 = 0.5.
    const display = overlayAtPlayhead(ov, 4, FPS)!;
    expect(display).not.toBe(ov); // a fresh object
    expect(display.rect.x).toBeCloseTo(300); // 100 → 500 @ 0.5
    expect(display.rect.y).toBe(100); // constant
    expect(display.opacity).toBeCloseTo(0.5); // 1 → 0 @ 0.5
    // id preserved so commits stay id-based.
    expect(display.id).toBe("ov1");
  });

  it("resolves a quarter into the window", () => {
    const ov = keyframedOverlay();
    // playhead at 3s → local t = (3-2)/4 = 0.25.
    const display = overlayAtPlayhead(ov, 3, FPS)!;
    expect(display.rect.x).toBeCloseTo(200); // 100 → 500 @ 0.25
    expect(display.opacity).toBeCloseTo(0.75); // 1 → 0 @ 0.25
  });

  it("clamps a playhead BEFORE the window to t=0 (first keyframe value)", () => {
    const ov = keyframedOverlay();
    const display = overlayAtPlayhead(ov, 0, FPS)!; // before startTime (2s)
    expect(display.rect.x).toBeCloseTo(100);
    expect(display.opacity).toBeCloseTo(1);
  });

  it("clamps a playhead AFTER the window to t=1 (last keyframe value)", () => {
    const ov = keyframedOverlay();
    const display = overlayAtPlayhead(ov, 100, FPS)!; // well past window end (6s)
    expect(display.rect.x).toBeCloseTo(500);
    expect(display.opacity).toBeCloseTo(0);
  });

  it("keeps the base transform3d fallback (identity) when only rect/opacity are keyed", () => {
    const ov = keyframedOverlay();
    const display = overlayAtPlayhead(ov, 4, FPS)!;
    expect(display.transform3d).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  });
});
