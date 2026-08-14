import { describe, it, expect, vi } from "vitest";
import {
  overlayNeedsSpatialQuad,
  selectSpatialOverlays,
  buildOverlaySpatialQuadsWithDeps,
} from "@/lib/export/render-entry-quads";
import type { Overlay, TextOverlay, Transform3D } from "@/lib/engine/types";

const rect = { x: 0, y: 0, width: 100, height: 50 };
const t3d = (over: Partial<Transform3D> = {}): Transform3D => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  ...over,
});
const img = (id: string, transform3d?: Transform3D): Overlay =>
  ({ id, kind: "image", startTime: 0, duration: 1, z: 0, rect, opacity: 1, fileId: "f", transform3d } as Overlay);

const SPATIAL = t3d({ rotation: { x: 0.3, y: 0, z: 0 } }); // out-of-plane pitch
const PLANAR = t3d({ rotation: { x: 0, y: 0, z: 0.5 } }); // in-plane spin only

describe("overlayNeedsSpatialQuad", () => {
  it("image with an out-of-plane (spatial) transform → true", () => {
    expect(overlayNeedsSpatialQuad(img("a", SPATIAL))).toBe(true);
  });
  it("image with only in-plane spin (planar) → false", () => {
    expect(overlayNeedsSpatialQuad(img("a", PLANAR))).toBe(false);
  });
  it("flat image (identity) → false", () => {
    expect(overlayNeedsSpatialQuad(img("a"))).toBe(false);
  });
  it("video / code with a spatial transform → true", () => {
    expect(overlayNeedsSpatialQuad({ ...img("v", SPATIAL), kind: "video" } as Overlay)).toBe(true);
    expect(overlayNeedsSpatialQuad({ ...img("c", SPATIAL), kind: "code", drawFunction: "" } as unknown as Overlay)).toBe(true);
  });
  it("flat-text with a spatial transform → true; text WITH threeD → false (uses three instance)", () => {
    const flatText = { id: "t", kind: "text", startTime: 0, duration: 1, z: 0, rect, opacity: 1, content: "x", transform3d: SPATIAL } as TextOverlay;
    expect(overlayNeedsSpatialQuad(flatText)).toBe(true);
    expect(overlayNeedsSpatialQuad({ ...flatText, threeD: { depth: 20 } })).toBe(false);
  });
  it("three overlay → false (owns the three renderer)", () => {
    const three = { id: "x", kind: "three", startTime: 0, duration: 1, z: 0, rect, opacity: 1, sceneFunction: "", transform3d: SPATIAL } as Overlay;
    expect(overlayNeedsSpatialQuad(three)).toBe(false);
  });
});

describe("selectSpatialOverlays", () => {
  it("filters to spatial-2D overlays, preserving order", () => {
    const list = [img("a", SPATIAL), img("b"), img("c", PLANAR), img("d", SPATIAL)];
    expect(selectSpatialOverlays(list).map((o) => o.id)).toEqual(["a", "d"]);
  });
});

describe("buildOverlaySpatialQuadsWithDeps", () => {
  const makeDeps = () => {
    const sharedDispose = vi.fn();
    const shared = { renderer: {}, dispose: sharedDispose } as never;
    const instances: { dispose: ReturnType<typeof vi.fn> }[] = [];
    const deps = {
      createSharedThreeRenderer: vi.fn(async () => shared),
      buildQuadInstance: vi.fn(async () => {
        const inst = { render: vi.fn(), dispose: vi.fn() };
        instances.push(inst);
        return inst as never;
      }),
    };
    return { deps, sharedDispose, instances };
  };

  it("builds one quad per spatial overlay, keyed by id", async () => {
    const { deps } = makeDeps();
    const { quads } = await buildOverlaySpatialQuadsWithDeps([img("a", SPATIAL), img("b"), img("c", SPATIAL)], deps);
    expect(Object.keys(quads).sort()).toEqual(["a", "c"]);
    expect(deps.createSharedThreeRenderer).toHaveBeenCalledTimes(1);
    expect(deps.buildQuadInstance).toHaveBeenCalledTimes(2);
  });

  it("no spatial overlays → no renderer created, empty map, no-op dispose", async () => {
    const { deps, sharedDispose } = makeDeps();
    const res = await buildOverlaySpatialQuadsWithDeps([img("a"), img("b", PLANAR)], deps);
    expect(res.quads).toEqual({});
    expect(deps.createSharedThreeRenderer).not.toHaveBeenCalled();
    res.dispose();
    expect(sharedDispose).not.toHaveBeenCalled();
  });

  it("dispose frees every instance + the shared renderer", async () => {
    const { deps, sharedDispose, instances } = makeDeps();
    const res = await buildOverlaySpatialQuadsWithDeps([img("a", SPATIAL), img("b", SPATIAL)], deps);
    res.dispose();
    expect(instances).toHaveLength(2);
    for (const i of instances) expect(i.dispose).toHaveBeenCalledTimes(1);
    expect(sharedDispose).toHaveBeenCalledTimes(1);
  });

  it("a per-instance build failure is skipped, not fatal", async () => {
    const { deps } = makeDeps();
    deps.buildQuadInstance = vi
      .fn()
      .mockRejectedValueOnce(new Error("webgl boom"))
      .mockImplementation(async () => ({ render: vi.fn(), dispose: vi.fn() }) as never);
    const { quads } = await buildOverlaySpatialQuadsWithDeps([img("a", SPATIAL), img("b", SPATIAL)], deps);
    expect(Object.keys(quads)).toEqual(["b"]); // "a" failed and was skipped
  });
});
