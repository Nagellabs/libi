import { describe, it, expect } from "vitest";
import {
  resolveOverlayTransform,
  resolveFlip,
  classifyTransform,
  planarCanvas2DOps,
  inversePlanarPoint,
  splitScreenRoll,
  rotatePointAround,
} from "@/lib/engine/overlay-transform";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

const DEG = Math.PI / 180;

const NO_FLIP = { flipH: false, flipV: false };

describe("resolveOverlayTransform", () => {
  it("returns identity for a bare overlay", () => {
    expect(resolveOverlayTransform({})).toEqual(IDENTITY_TRANSFORM3D);
  });

  it("returns transform3d as-is (the single rotation authority)", () => {
    const t3d = { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.1 } };
    // No legacy rotation to fold — the stored transform3d IS the result.
    expect(resolveOverlayTransform({ transform3d: t3d })).toBe(t3d);
  });

  it("reads the in-plane spin off transform3d.rotation.z", () => {
    const t3d = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 * DEG } };
    const t = resolveOverlayTransform({ transform3d: t3d });
    expect(t.rotation.z).toBeCloseTo(90 * DEG, 6);
    expect(t.rotation.x).toBe(0);
    expect(t.rotation.y).toBe(0);
  });

  it("does NOT fold flipH/flipV into the transform — output has no scale key", () => {
    const t = resolveOverlayTransform({ flipH: true, flipV: true });
    // flip is purely on the booleans, not the transform
    expect(t).toEqual(IDENTITY_TRANSFORM3D);
    expect("scale" in t).toBe(false);
  });

  it("output never has a scale key", () => {
    const t = resolveOverlayTransform({
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 45 * DEG } },
      flipH: true,
    });
    expect("scale" in t).toBe(false);
  });
});

describe("resolveFlip", () => {
  it("returns false/false for a bare overlay", () => {
    expect(resolveFlip({})).toEqual({ flipH: false, flipV: false });
  });

  it("returns true/false for flipH:true", () => {
    expect(resolveFlip({ flipH: true })).toEqual({ flipH: true, flipV: false });
  });

  it("returns false/true for flipV:true", () => {
    expect(resolveFlip({ flipV: true })).toEqual({ flipH: false, flipV: true });
  });

  it("returns true/true for both", () => {
    expect(resolveFlip({ flipH: true, flipV: true })).toEqual({ flipH: true, flipV: true });
  });
});

describe("splitScreenRoll", () => {
  it("returns the transform unchanged + roll 0 when rotation.z is 0", () => {
    const t = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0.4, y: 0.5, z: 0 } };
    const { spatial, rollRad } = splitScreenRoll(t);
    expect(spatial).toBe(t);
    expect(rollRad).toBe(0);
  });

  it("peels rotation.z off as the screen-roll, leaving x/y/position intact", () => {
    const t = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0.4, y: 0.5, z: 0.6 } };
    const { spatial, rollRad } = splitScreenRoll(t);
    expect(rollRad).toBe(0.6);
    expect(spatial.rotation).toEqual({ x: 0.4, y: 0.5, z: 0 });
    expect(spatial.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("a pure z-roll splits to identity-spatial + the roll (the screen-roll model)", () => {
    const t = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.9 } };
    const { spatial, rollRad } = splitScreenRoll(t);
    expect(rollRad).toBe(0.9);
    expect(classifyTransform(spatial)).toBe("identity");
  });
});

describe("rotatePointAround", () => {
  it("is a no-op for 0 rad", () => {
    expect(rotatePointAround(10, 20, 5, 5, 0)).toEqual({ x: 10, y: 20 });
  });

  it("rotates 90° clockwise about the center", () => {
    // (1,0) about origin, +90° CW (screen y-down): → (0,1)
    const p = rotatePointAround(1, 0, 0, 0, Math.PI / 2);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it("inverse undoes the forward rotation", () => {
    const fwd = rotatePointAround(30, 12, 10, 10, 0.7);
    const back = rotatePointAround(fwd.x, fwd.y, 10, 10, -0.7);
    expect(back.x).toBeCloseTo(30, 6);
    expect(back.y).toBeCloseTo(12, 6);
  });
});

describe("classifyTransform", () => {
  it("identity for the identity transform", () => {
    expect(classifyTransform(IDENTITY_TRANSFORM3D)).toBe("identity");
  });

  it("planar for in-plane only (z-rot, xy-pos)", () => {
    expect(classifyTransform({
      position: { x: 10, y: -5, z: 0 },
      rotation: { x: 0, y: 0, z: 0.5 },
    })).toBe("planar");
  });

  it("spatial when rotation.x is non-zero", () => {
    expect(classifyTransform({
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.3, y: 0, z: 0 },
    })).toBe("spatial");
  });

  it("spatial when rotation.y is non-zero", () => {
    expect(classifyTransform({
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: -0.2, z: 0 },
    })).toBe("spatial");
  });

  it("spatial when position.z is non-zero", () => {
    expect(classifyTransform({
      position: { x: 0, y: 0, z: 4 }, rotation: { x: 0, y: 0, z: 0 },
    })).toBe("spatial");
  });
});

describe("planarCanvas2DOps + inversePlanarPoint round-trip", () => {
  const box = { x: 100, y: 50, width: 200, height: 80 };

  it("identity ops are empty and the inverse is a no-op", () => {
    const ops = planarCanvas2DOps(IDENTITY_TRANSFORM3D, box, NO_FLIP);
    expect(ops).toEqual([]);
    expect(inversePlanarPoint(IDENTITY_TRANSFORM3D, box, NO_FLIP, 150, 90)).toEqual({ x: 150, y: 90 });
  });

  it("a point at the box center is invariant under center-anchored rotation", () => {
    const t = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 45 * DEG } };
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const inv = inversePlanarPoint(t, box, NO_FLIP, cx, cy);
    expect(inv.x).toBeCloseTo(cx, 6);
    expect(inv.y).toBeCloseTo(cy, 6);
  });

  it("inverse undoes a positional offset", () => {
    const t = { position: { x: 30, y: -10, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
    const inv = inversePlanarPoint(t, box, NO_FLIP, 180, 80);
    expect(inv.x).toBeCloseTo(150, 6);
    expect(inv.y).toBeCloseTo(90, 6);
  });

  it("flip-only (no rotation) still produces affine ops including scale", () => {
    const ops = planarCanvas2DOps(IDENTITY_TRANSFORM3D, box, { flipH: true, flipV: false });
    expect(ops.length).toBeGreaterThan(0);
    const scaleOp = ops.find((o) => o.kind === "scale");
    expect(scaleOp).toBeDefined();
    expect(scaleOp).toMatchObject({ kind: "scale", x: -1, y: 1 });
  });

  it("flip:false/false on identity returns empty ops", () => {
    expect(planarCanvas2DOps(IDENTITY_TRANSFORM3D, box, { flipH: false, flipV: false })).toEqual([]);
  });

  it("flipH+flipV produces scale(-1,-1) op", () => {
    const ops = planarCanvas2DOps(IDENTITY_TRANSFORM3D, box, { flipH: true, flipV: true });
    const scaleOp = ops.find((o) => o.kind === "scale");
    expect(scaleOp).toMatchObject({ kind: "scale", x: -1, y: -1 });
  });
});

import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { TextOverlay, Transform3D } from "@/lib/engine/types";

function fakeCtx() {
  const calls: string[] = [];
  return {
    calls,
    save() { calls.push("save"); }, restore() { calls.push("restore"); },
    translate() {}, rotate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
    drawImage() { calls.push("drawImage"); },
    set globalAlpha(_v: number) {}, set filter(_v: string) {},
    fillText() {}, measureText() { return { width: 10 }; }, fillRect() {},
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
}

describe("drawOverlay feeds the overlay's real transform to 3D text", () => {
  it("calls applyTransform with transform3d (NOT identity) for a 3D text overlay", () => {
    const seen: Transform3D[] = [];
    const inst = {
      update: () => {},
      applyTransform: (t: Transform3D) => { seen.push(t); },
      render: () => ({ width: 10, height: 10 } as unknown as HTMLCanvasElement),
      dispose: () => {},
      ready: Promise.resolve(),
    };
    const t3d = { position: { x: 7, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
    const overlay: TextOverlay = {
      id: "o1", kind: "text", content: "Hi", font: "48px Inter", color: "#fff", align: "center",
      startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 100, height: 40 },
      threeD: { depth: 20 }, transform3d: t3d,
    };
    const ctx = fakeCtx();
    const drawCtx: DrawOverlayContext = {
      ctx, time: 0.5, frame: 15, totalFrames: 60, fps: 30, width: 100, height: 40,
      assets: {}, threeScenes: { o1: inst },
    };
    drawOverlay(overlay, drawCtx);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(t3d); // the REAL transform, not IDENTITY_TRANSFORM3D
  });
});
