import { describe, it, expect, vi } from "vitest";

// Minimal three fake — only the classes the helpers touch.
const fakeTHREE = {
  PerspectiveCamera: class {
    fov: number; aspect: number; near: number; far: number;
    position = { set: vi.fn() };
    lookAt = vi.fn();
    updateProjectionMatrix = vi.fn();
    constructor(fov: number, aspect: number, near: number, far: number) {
      this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    }
  },
  Mesh: class { constructor(public geo: unknown, public mat: unknown) {} rotation = { x: 0 }; },
  PlaneGeometry: class { constructor(public w: number, public h: number) {} },
  MeshBasicMaterial: class { constructor(public opts: unknown) {} },
};

import { applyCameraPreset, THREE3D_HELPERS } from "@/lib/engine/three-helpers";

describe("three-helpers", () => {
  it("applyCameraPreset returns a perspective camera for each preset", () => {
    const ground = applyCameraPreset(fakeTHREE as never, "ground");
    const billboard = applyCameraPreset(fakeTHREE as never, "billboard");
    expect(ground.position.set).toHaveBeenCalled();
    expect(billboard.position.set).toHaveBeenCalled();
  });

  it("groundPlane builds a mesh lying flat", () => {
    const mesh = THREE3D_HELPERS.groundPlane(fakeTHREE as never, { size: 10 });
    expect(mesh).toBeTruthy();
  });

  it("glowText sets emissive-ish outline props on a text-like object", () => {
    const t: Record<string, unknown> = {};
    THREE3D_HELPERS.glowText(t, { color: "#ff00ff", intensity: 1 });
    expect(t.color).toBe("#ff00ff");
    expect(typeof t.outlineBlur).toBe("number");
  });
});

import * as THREE from "three";

describe("applyCameraPreset — extended presets", () => {
  const presets = ["billboard", "ground", "lowAngle", "highAngle", "angled"] as const;

  it("returns a PerspectiveCamera for every preset", () => {
    for (const p of presets) {
      const cam = applyCameraPreset(THREE, p);
      expect(cam).toBeInstanceOf(THREE.PerspectiveCamera);
    }
  });

  it("gives each preset a distinct camera position", () => {
    const keys = presets.map((p) => {
      const c = applyCameraPreset(THREE, p);
      return `${c.position.x.toFixed(2)},${c.position.y.toFixed(2)},${c.position.z.toFixed(2)}`;
    });
    expect(new Set(keys).size).toBe(presets.length);
  });

  it("lowAngle sits below and highAngle sits above the billboard eyeline", () => {
    expect(applyCameraPreset(THREE, "lowAngle").position.y).toBeLessThan(0);
    expect(applyCameraPreset(THREE, "highAngle").position.y).toBeGreaterThan(1.5);
  });
});
