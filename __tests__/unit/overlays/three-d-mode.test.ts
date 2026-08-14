import { describe, it, expect } from "vitest";
import { isOverlayIn3dMode, withSynthesizedThreeD } from "@/lib/overlays/three-d-mode";
import { flattenOverlay } from "@/lib/captions/flat-guard";
import type { TextOverlay, CodeOverlay, ThreeOverlay } from "@/lib/engine/types";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };
const txt = (over: Partial<TextOverlay>): TextOverlay =>
  ({ id: "t", kind: "text", startTime: 0, duration: 1, z: 0, rect: baseRect, opacity: 1, content: "hi", ...over } as TextOverlay);
const code = (over: Partial<CodeOverlay>): CodeOverlay =>
  ({ id: "c", kind: "code", startTime: 0, duration: 1, z: 0, rect: baseRect, opacity: 1, drawFunction: "", ...over } as CodeOverlay);

describe("isOverlayIn3dMode", () => {
  it("reads the explicit flag when present", () => {
    expect(isOverlayIn3dMode(code({ place3d: true }))).toBe(true);
    expect(isOverlayIn3dMode(code({ place3d: false }))).toBe(false);
  });
  it("three is always 3D regardless of flag", () => {
    const three = { id: "x", kind: "three", startTime: 0, duration: 1, z: 0, rect: baseRect, opacity: 1, sceneFunction: "" } as ThreeOverlay;
    expect(isOverlayIn3dMode(three)).toBe(true);
  });
  it("legacy text with threeD (no flag) infers 3D", () => {
    expect(isOverlayIn3dMode(txt({ threeD: { depth: 20 } }))).toBe(true);
  });
  it("legacy overlay with a spatial transform (no flag) infers 3D", () => {
    expect(isOverlayIn3dMode(code({ transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.5, y: 0, z: 0 } } }))).toBe(true);
  });
  it("plain flat overlay is not 3D", () => {
    expect(isOverlayIn3dMode(code({}))).toBe(false);
    expect(isOverlayIn3dMode(txt({}))).toBe(false);
  });
});

describe("withSynthesizedThreeD", () => {
  it("synthesizes a flat depth:0 threeD for place3d-only text (no extrusion)", () => {
    const o = txt({ place3d: true });
    const built = withSynthesizedThreeD(o);
    expect(built.threeD).toEqual({ depth: 0 });
    // BUILD-time only — the source overlay is not mutated / persisted.
    expect(o.threeD).toBeUndefined();
  });
  it("returns the SAME object (no synthesis) when threeD already exists", () => {
    const o = txt({ place3d: true, threeD: { depth: 20 } });
    const built = withSynthesizedThreeD(o);
    expect(built).toBe(o);
    expect(built.threeD).toEqual({ depth: 20 });
  });
});

describe("flattenOverlay", () => {
  it("clears place3d, drops text threeD, zeros pitch/yaw/z, keeps spin + pos x/y", () => {
    const o = txt({
      place3d: true,
      threeD: { depth: 20 },
      transform3d: { position: { x: 10, y: 20, z: 99 }, rotation: { x: 1, y: 1, z: 0.7 } },
    });
    const f = flattenOverlay(o) as TextOverlay;
    expect(f.place3d).toBe(false);
    expect(f.threeD).toBeUndefined();
    expect(f.transform3d!.rotation.x).toBe(0);
    expect(f.transform3d!.rotation.y).toBe(0);
    expect(f.transform3d!.position.z).toBe(0);
    expect(f.transform3d!.rotation.z).toBe(0.7); // in-plane spin preserved
    expect(f.transform3d!.position.x).toBe(10);  // pos x/y preserved
  });
  it("is a no-op for an already-flat overlay", () => {
    const o = code({});
    expect(flattenOverlay(o)).toEqual(o);
  });
  it("flattens code (no threeD field) too", () => {
    const o = code({ place3d: true, transform3d: { position: { x: 0, y: 0, z: 50 }, rotation: { x: 0.3, y: 0, z: 0 } } });
    const f = flattenOverlay(o) as CodeOverlay;
    expect(f.place3d).toBe(false);
    expect(f.transform3d!.rotation.x).toBe(0);
    expect(f.transform3d!.position.z).toBe(0);
  });
});
