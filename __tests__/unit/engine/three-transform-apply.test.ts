import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Spies on the scene root's transform setters ──────────────────────────────
const scenePositionSet = vi.fn();
const sceneRotationSet = vi.fn();
const sceneScaleSet = vi.fn();
const sceneScaleSetScalar = vi.fn();
const renderSpy = vi.fn();
const setSizeSpy = vi.fn();
const fakeDomElement = { width: 0, height: 0 };

// A real-enough THREE mock: the Scene exposes position/rotation/scale with
// .set() spies (a real THREE.Scene IS an Object3D and has these), so we can
// assert applyTransform writes through to the scene root.
vi.mock("three", () => {
  // Minimal-but-chainable math so the content-fit camera path (clone/copy/equals/
  // applyQuaternion/Box3/Sphere) runs without crashing. Box3 reports EMPTY, so the
  // fit no-ops — these tests only assert applyTransform write-through + render.
  class V3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s: number) { this.x = this.y = this.z = s; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    copy(v: V3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    equals(v: V3) { return this.x === v.x && this.y === v.y && this.z === v.z; }
    applyQuaternion() { return this; }
    normalize() { return this; }
    addScaledVector() { return this; }
    applyMatrix4() { return this; }
  }
  class Quat {
    clone() { return new Quat(); }
    copy() { return this; }
    identity() { return this; }
    equals() { return true; }
  }
  class Box3 {
    setFromObject() { return this; }
    isEmpty() { return true; }
    getCenter(t: V3) { return t; }
    getSize(t: V3) { return t; }
    getBoundingSphere(s: { center: V3; radius: number }) { s.radius = 0; return s; }
  }
  class Sphere {
    radius = 0;
    constructor(public center: V3) {}
  }
  class PerspectiveCamera {
    fov = 50;
    aspect = 1;
    position = new V3(0, 0, 6);
    quaternion = new Quat();
    lookAt = vi.fn();
    updateProjectionMatrix = vi.fn();
    clearViewOffset = vi.fn();
    constructor(fov?: number, a?: number) {
      if (fov) this.fov = fov;
      if (a) this.aspect = a;
    }
  }
  // Scene transform setters route to the assertion spies but stay chainable so
  // the fit path's clone/copy/identity calls don't crash.
  function spiedVec(setSpy: (...a: number[]) => void, extra?: Record<string, unknown>) {
    return Object.assign(new V3(), { set: setSpy }, extra ?? {});
  }
  class Scene {
    children: unknown[] = [];
    matrixWorld = {};
    position = spiedVec(scenePositionSet);
    rotation = spiedVec(sceneRotationSet);
    quaternion = new Quat();
    scale = spiedVec(sceneScaleSet, { setScalar: sceneScaleSetScalar });
    updateMatrixWorld = vi.fn();
    add(o: unknown) { this.children.push(o); }
    traverse(cb: (o: unknown) => void) { this.children.forEach(cb); }
  }
  class WebGLRenderer {
    domElement = fakeDomElement;
    setSize = setSizeSpy;
    render = renderSpy;
    setPixelRatio = vi.fn();
    setClearColor = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
  }
  class AmbientLight {}
  return { PerspectiveCamera, Scene, WebGLRenderer, AmbientLight, Vector3: V3, Box3, Sphere };
});

vi.mock("@/lib/engine/canvas-text", () => {
  class CanvasText {
    text = "";
    sync = vi.fn((cb?: () => void) => cb && cb());
    dispose = vi.fn();
    position = { set: vi.fn(), z: 0 };
    rotation = { x: 0 };
    material = { opacity: 1, transparent: true };
  }
  return { makeCanvasTextClass: () => CanvasText };
});

import { createSharedThreeRenderer, buildThreeInstance } from "@/lib/engine/three-overlay";
import type { ThreeOverlayInstance, ThreeFrameApi } from "@/lib/engine/three-overlay";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

function mockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  scenePositionSet.mockClear();
  sceneRotationSet.mockClear();
  sceneScaleSet.mockClear();
  sceneScaleSetScalar.mockClear();
  renderSpy.mockClear();
  setSizeSpy.mockClear();
});

describe("ThreeOverlayInstance.applyTransform", () => {
  it("writes position + rotation through and resets scene scale to 1", async () => {
    const shared = await createSharedThreeRenderer();
    const inst = await buildThreeInstance(
      "const amb = new THREE.AmbientLight(); scene.add(amb);",
      "billboard",
      shared,
    );
    await inst.ready;
    inst.applyTransform({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 1, z: 0 } });
    expect(scenePositionSet).toHaveBeenCalledWith(1, 2, 3);
    expect(sceneRotationSet).toHaveBeenCalledWith(0, 1, 0);
    expect(sceneScaleSetScalar).toHaveBeenCalledWith(1);
  });

  it("renders into the base rect with no view offset", async () => {
    const shared = await createSharedThreeRenderer();
    const inst = await buildThreeInstance(
      "const amb = new THREE.AmbientLight(); scene.add(amb);",
      "billboard",
      shared,
    );
    await inst.ready;
    inst.render(400, 300);
    expect(setSizeSpy).toHaveBeenCalledWith(400, 300, false);
    expect(renderSpy).toHaveBeenCalled();
  });
});

describe('overlay renderer "three" case applies transform3d', () => {
  function fakeInstance() {
    const calls: { applyTransform: unknown[]; update: ThreeFrameApi[] } = {
      applyTransform: [],
      update: [],
    };
    const inst: ThreeOverlayInstance = {
      update: (api) => {
        calls.update.push(api);
      },
      applyTransform: (t) => {
        calls.applyTransform.push(t);
      },
      render: () => ({ width: 100, height: 100 }) as unknown as HTMLCanvasElement,
      dispose: () => {},
      ready: Promise.resolve(),
    };
    return { inst, calls };
  }

  it("calls inst.applyTransform with the overlay's transform3d", () => {
    const { inst, calls } = fakeInstance();
    const transform3d = {
      position: { x: 5, y: 0, z: 0 },
      rotation: { x: 0, y: 0.5, z: 0 },
    };
    const overlay: Overlay = {
      id: "tov",
      kind: "three",
      startTime: 0,
      duration: 2,
      z: 1,
      opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      sceneFunction: "/* unused */",
      transform3d,
    };
    const drawCtx: DrawOverlayContext = {
      ctx: mockCtx(),
      width: 1920,
      height: 1080,
      fps: 30,
      frame: 30,
      time: 1,
      totalFrames: 60,
      assets: {},
      threeScenes: { tov: inst },
    };
    drawOverlay(overlay, drawCtx);

    expect(calls.applyTransform).toHaveLength(1);
    expect(calls.applyTransform[0]).toEqual(transform3d);
    // It's also forwarded to update() so a template MAY read it.
    expect(calls.update[0]?.transform3d).toEqual(transform3d);
  });

  it("falls back to IDENTITY when the overlay has no transform3d", () => {
    const { inst, calls } = fakeInstance();
    const overlay: Overlay = {
      id: "tov2",
      kind: "three",
      startTime: 0,
      duration: 2,
      z: 1,
      opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      sceneFunction: "/* unused */",
    };
    const drawCtx: DrawOverlayContext = {
      ctx: mockCtx(),
      width: 1920,
      height: 1080,
      fps: 30,
      frame: 0,
      time: 0,
      totalFrames: 60,
      assets: {},
      threeScenes: { tov2: inst },
    };
    drawOverlay(overlay, drawCtx);

    expect(calls.applyTransform[0]).toEqual(IDENTITY_TRANSFORM3D);
  });
});

describe("in-plane roll is applied exactly ONCE for self-rolling kinds", () => {
  function fakeInstance(): ThreeOverlayInstance {
    return {
      update: () => {},
      applyTransform: () => {},
      render: () => ({ width: 100, height: 100 }) as unknown as HTMLCanvasElement,
      dispose: () => {},
      ready: Promise.resolve(),
    };
  }
  const baseCtx = (ctx: CanvasRenderingContext2D): Omit<DrawOverlayContext, "threeScenes"> => ({
    ctx,
    width: 1920,
    height: 1080,
    fps: 30,
    frame: 0,
    time: 0,
    totalFrames: 60,
    assets: {},
  });
  const roll = 0.35;
  const pureRoll = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: roll } };

  it("`three` overlay with a pure roll rotates the ctx exactly once", () => {
    const ctx = mockCtx();
    const overlay: Overlay = {
      id: "t1", kind: "three", startTime: 0, duration: 2, z: 1, opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      sceneFunction: "/* unused */",
      transform3d: pureRoll,
    };
    drawOverlay(overlay, { ...baseCtx(ctx), threeScenes: { t1: fakeInstance() } });
    const rotates = (ctx.rotate as ReturnType<typeof vi.fn>).mock.calls;
    expect(rotates).toHaveLength(1);
    expect(rotates[0][0]).toBeCloseTo(roll, 10);
  });

  it("3D-mode text (place3d) with a pure roll rotates the ctx exactly once", () => {
    const ctx = mockCtx();
    const overlay: Overlay = {
      id: "t2", kind: "text", startTime: 0, duration: 2, z: 1, opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      content: "Hi", font: "48px Inter", color: "#fff", align: "center",
      place3d: true,
      transform3d: pureRoll,
    };
    drawOverlay(overlay, { ...baseCtx(ctx), threeScenes: { t2: fakeInstance() } });
    const rotates = (ctx.rotate as ReturnType<typeof vi.fn>).mock.calls;
    expect(rotates).toHaveLength(1);
    expect(rotates[0][0]).toBeCloseTo(roll, 10);
  });
});
