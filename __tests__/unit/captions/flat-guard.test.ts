import { describe, it, expect } from "vitest";
import { isCaptionFlat, flattenCaption } from "@/lib/captions/flat-guard";
import type { TextOverlay } from "@/lib/engine/types";

const base = (over: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "t1", kind: "text", content: "hello world", font: "100px Inter", color: "#fff",
  align: "center", fontSize: 62, startTime: 0, duration: 2, z: 1,
  ...over,
} as TextOverlay);

describe("flat-guard", () => {
  it("isCaptionFlat is true only when neither threeD nor place3d is set", () => {
    expect(isCaptionFlat(base())).toBe(true);
    expect(isCaptionFlat(base({ threeD: { depth: 20 } }))).toBe(false);
    // A "Make it 3D" caption (place3d on) is NOT flat even without extrusion.
    expect(isCaptionFlat(base({ place3d: true }))).toBe(false);
  });
  it("flattenCaption PRESERVES pitch/yaw on a place3d caption (the reported bug)", () => {
    // place3d on, no extrusion (threeD absent): the caption is intentionally
    // tilted; flattenCaption must keep rotation.x/y instead of zeroing them.
    const tilted = base({
      place3d: true,
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.55, y: 0.3, z: 0 } },
    });
    const out = flattenCaption(tilted);
    expect(out.transform3d?.rotation.x).toBeCloseTo(0.55, 6);
    expect(out.transform3d?.rotation.y).toBeCloseTo(0.3, 6);
  });
  it("flattenCaption zeroes a stray 3D X/Y rotation on a flat caption (the bug state)", () => {
    const broken = base({ transform3d: { position: { x: 0, y: 1, z: 0 }, rotation: { x: -0.0349, y: 1.5533, z: 0 } } });
    const fixed = flattenCaption(broken);
    expect(fixed.transform3d?.rotation.x).toBe(0);
    expect(fixed.transform3d?.rotation.y).toBe(0);
    expect(fixed.threeD).toBeUndefined();
  });
  it("flattenCaption preserves the in-plane z-roll (transform3d.rotation.z)", () => {
    const o = base({ transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.5 } } });
    const fixed = flattenCaption(o);
    expect(fixed.transform3d?.rotation.z).toBe(0.5);
  });
  it("flattenCaption is a no-op for a 3D caption", () => {
    const o = base({ threeD: { depth: 20 }, transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1.2, z: 0 } } });
    expect(flattenCaption(o)).toEqual(o);
  });
});
