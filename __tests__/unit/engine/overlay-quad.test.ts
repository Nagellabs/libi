import { describe, it, expect, vi } from "vitest";

// ── Minimal three stub ──
// Modelled on __tests__/unit/text-3d/build-text-three.test.ts
vi.mock("three", () => {
  const SRGBColorSpace = "srgb";
  const DoubleSide = 2;

  class Vec3Stub {
    x = 0; y = 0; z = 0;
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  }

  class EulerStub {
    x = 0; y = 0; z = 0;
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  }

  class Scene {
    add(_obj: unknown) {}
  }

  class PerspectiveCamera {
    aspect = 1;
    fov = 50;
    position = new Vec3Stub();
    lookAt(_x: number, _y: number, _z: number) {}
    updateProjectionMatrix() {}
    setViewOffset(_fullW: number, _fullH: number, _offX: number, _offY: number, _subW: number, _subH: number) {}
    clearViewOffset() {}
    constructor(fov?: number, aspect?: number, near?: number, far?: number) {
      if (fov != null) this.fov = fov;
      if (aspect != null) this.aspect = aspect;
    }
  }

  class PlaneGeometry {
    constructor(public width?: number, public height?: number) {}
    dispose() {}
  }

  class CanvasTexture {
    needsUpdate = false;
    colorSpace = "";
    image: unknown = null;
    constructor(source: unknown) { this.image = source; }
    dispose() {}
  }

  class MeshBasicMaterial {
    constructor(public opts?: unknown) {}
    dispose() {}
  }

  class Mesh {
    position = new Vec3Stub();
    rotation = new EulerStub();
    scale = new Vec3Stub();
    constructor(public geometry?: unknown, public material?: unknown) {}
  }

  return {
    Scene,
    PerspectiveCamera,
    PlaneGeometry,
    CanvasTexture,
    MeshBasicMaterial,
    Mesh,
    SRGBColorSpace,
    DoubleSide,
  };
});

import { buildQuadInstance } from "@/lib/engine/overlay-quad";
import type { SharedThreeRenderer } from "@/lib/engine/three-overlay";

function makeStubShared() {
  const calls: string[] = [];
  const glCanvas = { kind: "glCanvas" } as unknown as HTMLCanvasElement;
  const shared: SharedThreeRenderer = {
    renderer: {
      setSize: vi.fn(),
      render: vi.fn(() => { calls.push("render"); }),
      domElement: glCanvas,
    } as unknown as SharedThreeRenderer["renderer"],
    dispose: vi.fn(),
  };
  return { shared, glCanvas, calls };
}

const IDENTITY = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};
const NO_FLIP = { flipH: false, flipV: false };

describe("buildQuadInstance", () => {
  it("renders the content canvas as a textured plane and returns the shared GL canvas", async () => {
    const { shared, glCanvas, calls } = makeStubShared();
    const inst = await buildQuadInstance(shared);
    const content = { width: 200, height: 80 } as unknown as HTMLCanvasElement;
    const t = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.3, y: 0, z: 0 } };
    const out = inst.render(content, t, NO_FLIP, 200, 80, 200, 80, 0, 0);
    expect(out).toBe(glCanvas);
    expect(calls).toContain("render");
    expect(inst.__meshRotation!()).toMatchObject({ x: 0.3, y: 0, z: 0 });
  });

  it("flags the texture for re-upload each render (video/code change per frame)", async () => {
    const { shared } = makeStubShared();
    const inst = await buildQuadInstance(shared);
    const content = { width: 10, height: 10 } as unknown as HTMLCanvasElement;
    inst.render(content, IDENTITY, NO_FLIP, 10, 10, 10, 10, 0, 0);
    expect(inst.__textureNeedsUpdate!()).toBe(true);
  });

  it("disposes geometry, material, and texture on dispose()", async () => {
    const { shared } = makeStubShared();
    const THREE = await import("three");
    const geomDispose = vi.spyOn(THREE.PlaneGeometry.prototype, "dispose");
    const matDispose = vi.spyOn(THREE.MeshBasicMaterial.prototype, "dispose");
    const texDispose = vi.spyOn(THREE.CanvasTexture.prototype, "dispose");

    const inst = await buildQuadInstance(shared);
    inst.dispose();

    expect(geomDispose).toHaveBeenCalled();
    expect(matDispose).toHaveBeenCalled();
    expect(texDispose).toHaveBeenCalled();
  });

  it("calls setSize with the given dimensions before rendering", async () => {
    const { shared } = makeStubShared();
    const inst = await buildQuadInstance(shared);
    const content = { width: 320, height: 240 } as unknown as HTMLCanvasElement;
    inst.render(content, IDENTITY, NO_FLIP, 320, 240, 320, 240, 0, 0);
    expect(shared.renderer.setSize).toHaveBeenCalledWith(320, 240, false);
  });
});
