import { describe, it, expect, vi, beforeEach } from "vitest";

const renderSpy = vi.fn();
const setSizeSpy = vi.fn();
const fakeDomElement = { width: 0, height: 0 };

// Track the last PerspectiveCamera created so tests can spy on its methods.
let lastCamera: { clearViewOffset: ReturnType<typeof vi.fn>; updateProjectionMatrix: ReturnType<typeof vi.fn>; setViewOffset: ReturnType<typeof vi.fn> } | null = null;

vi.mock("three", () => {
  class Vector3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s: number) { this.x = this.y = this.z = s; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    copy(v: Vector3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    equals(v: Vector3) { return this.x === v.x && this.y === v.y && this.z === v.z; }
    applyQuaternion() { return this; }
    normalize() { return this; }
    addScaledVector() { return this; }
    applyMatrix4() { return this; }
    project(_cam: unknown) { this.x = 0; this.y = 0; return this; } // projects to center NDC
  }
  class Quat { clone() { return new Quat(); } copy() { return this; } identity() { return this; } equals() { return true; } }
  class PerspectiveCamera {
    aspect = 1; position = new Vector3(0, 0, 6); quaternion = new Quat(); lookAt = vi.fn(); updateProjectionMatrix = vi.fn();
    setViewOffset = vi.fn(); clearViewOffset = vi.fn();
    fov = 50;
    constructor(public _fov?: number, a?: number) { if (a) this.aspect = a; if (_fov) this.fov = _fov; lastCamera = this as unknown as typeof lastCamera; }
  }
  class Scene { children: unknown[] = []; matrixWorld = {}; updateMatrixWorld = vi.fn(); add(o: unknown) { this.children.push(o); } traverse(cb: (o: unknown) => void) { this.children.forEach(cb); }
    position = new Vector3(); rotation = new Vector3(); quaternion = new Quat(); scale = new Vector3(1, 1, 1);
  }
  class WebGLRenderer {
    domElement = fakeDomElement;
    setSize = setSizeSpy; render = renderSpy; setPixelRatio = vi.fn();
    setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
  }
  class AmbientLight {}
  class PlaneGeometry { dispose = vi.fn(); }
  class MeshBasicMaterial { dispose = vi.fn(); }
  class Mesh { rotation = { x: 0 }; constructor(public g?: unknown, public m?: unknown) {} }
  class Box3 {
    min = { x: -1, y: -1, z: -1 }; max = { x: 1, y: 1, z: 1 };
    setFromObject() { return this; }
    isEmpty() { return false; }
    getCenter(t: Vector3) { t.set(0, 0, 0); return t; }
    getSize(t: Vector3) { t.set(2, 2, 2); return t; }
    getBoundingSphere(s: { center: Vector3; radius: number }) { s.radius = 1.7; return s; }
  }
  class Sphere { radius = 0; constructor(public center: Vector3) {} }
  return { PerspectiveCamera, Scene, WebGLRenderer, AmbientLight, PlaneGeometry, MeshBasicMaterial, Mesh, Vector3, Quat, Box3, Sphere };
});

const textCtor = vi.fn();
// CanvasText is the synchronous Canvas2D-texture replacement for troika's Text.
// Mock the factory so buildThreeInstance gets a lightweight fake (the real one
// needs document/WebGL); sync() resolves immediately, matching production.
vi.mock("@/lib/engine/canvas-text", () => {
  class CanvasText {
    text = ""; sync = vi.fn((cb?: () => void) => cb && cb());
    dispose = vi.fn(); position = { set: vi.fn(), z: 0 }; rotation = { x: 0 };
    material = { opacity: 1, transparent: true };
    constructor() { textCtor(); }
  }
  return { makeCanvasTextClass: () => CanvasText };
});

import { createSharedThreeRenderer, buildThreeInstance } from "@/lib/engine/three-overlay";

beforeEach(() => { renderSpy.mockClear(); setSizeSpy.mockClear(); textCtor.mockClear(); lastCamera = null; });

describe("buildThreeInstance", () => {
  it("invokes the body ONCE, captures update, and renders on demand", async () => {
    const shared = await createSharedThreeRenderer();
    const body = `
const label = new Text();
label.text = "HI";
scene.add(label);
return ({ progress }) => { label.position.z = progress; };`;
    const inst = await buildThreeInstance(body, "ground", shared);
    await inst.ready;
    expect(textCtor).toHaveBeenCalledTimes(1); // built once
    inst.update?.({ frame: 0, time: 0, totalFrames: 10, duration: 1, progress: 0.5 });
    const canvas = inst.render(640, 360, 640, 360, 0, 0);
    expect(setSizeSpy).toHaveBeenCalledWith(640, 360, false);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(canvas).toBe((shared as unknown as { renderer: { domElement: unknown } }).renderer.domElement);
  });

  it("a body with no return renders a static scene without throwing", async () => {
    const shared = await createSharedThreeRenderer();
    const inst = await buildThreeInstance("const m = three3d.groundPlane(THREE, {}); scene.add(m);", "billboard", shared);
    await inst.ready;
    expect(() => inst.render(100, 100, 100, 100, 0, 0)).not.toThrow();
    expect(inst.update).toBeUndefined();
  });

  it("window model: render() always clears any view offset (no super-frame)", async () => {
    // The three overlay renders the scene INTO the rect window — it never sets a
    // camera view offset and has no contentBoundsNDC (that machinery now lives only
    // on the 3D-TEXT path; see build-text-three.test.ts). render() always clears any
    // offset so a leftover from a prior frame can't poison the next.
    const shared = await createSharedThreeRenderer();
    const inst = await buildThreeInstance("", "billboard", shared);
    await inst.ready;

    inst.render(640, 360);
    expect(lastCamera!.setViewOffset).not.toHaveBeenCalled();
    expect(lastCamera!.clearViewOffset).toHaveBeenCalled();
    expect(inst.contentBoundsNDC).toBeUndefined();
  });
});
