import { describe, it, expect, vi, beforeEach } from "vitest";

// Track the most recently constructed PerspectiveCamera so FIX A tests can spy on it.
const lastCamera: { current: { clearViewOffsetSpy: ReturnType<typeof vi.fn>; setViewOffsetSpy: ReturnType<typeof vi.fn>; updateProjectionMatrixSpy: ReturnType<typeof vi.fn> } | null } = { current: null };
import { buildTextThreeInstance, type BuildTextThreeDeps, type LoadedFontLike } from "@/lib/engine/text-3d/build-text-three";
import { markGeometryCached } from "@/lib/engine/text-3d/extrude";
import type { TextOverlay } from "@/lib/engine/types";
import type { SharedThreeRenderer } from "@/lib/engine/three-overlay";
import type { FontResolution } from "@/lib/engine/text-3d/font-resolve";

/** Tag a stub geometry as cache-owned, exactly as buildExtrudedMesh does before
 *  storing it in the geometry cache. The instance dispose() must skip these. */
function markCached<T extends object>(geo: T): T {
  return markGeometryCached(geo as unknown as import("three").BufferGeometry) as unknown as T;
}

// ── Minimal three stub: just enough surface for the builder + render() ──
function makeFakeThree() {
  const renderSpy = vi.fn();
  const setSizeSpy = vi.fn();
  const domElement = { width: 0, height: 0 };
  class Vec3Stub {
    x = 0; y = 0; z = 0;
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s: number) { this.x = s; this.y = s; this.z = s; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
    // project() needed by contentBoundsNDC's corner projection loop
    project(_camera: unknown) { this.x = 0; this.y = 0; return this; }
    copy(v: { x: number; y: number; z: number }) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  }
  // Minimal Box3: setFromObject yields a finite, non-degenerate box so the
  // fit-scale measurement (textW/textH) is well-defined in tests.
  class Box3Stub {
    min = { x: -1, y: -0.5, z: 0 };
    max = { x: 1, y: 0.5, z: 0.2 };
    setFromObject() { return this; }
    isEmpty() { return false; }
  }
  class Obj {
    position = new Vec3Stub();
    rotation = new Vec3Stub();
    scale = new Vec3Stub();
    visible = true;
    children: Obj[] = [];
    add(o: Obj) { this.children.push(o); return this; }
    traverse(cb: (o: Obj) => void) { cb(this); this.children.forEach((c) => c.traverse(cb)); }
  }
  class Scene extends Obj {}
  class Group extends Obj {}
  class PerspectiveCamera extends Obj {
    aspect = 1; fov = 50;
    clearViewOffsetSpy = vi.fn();
    updateProjectionMatrixSpy = vi.fn();
    setViewOffsetSpy = vi.fn();
    constructor(fov?: number, a?: number) {
      super(); if (fov) this.fov = fov; if (a) this.aspect = a;
      // Expose this camera so FIX A tests can assert on clearViewOffset.
      lastCamera.current = this;
    }
    lookAt() {}
    updateProjectionMatrix() { this.updateProjectionMatrixSpy(); }
    setViewOffset(...args: unknown[]) { this.setViewOffsetSpy(...args); }
    clearViewOffset() { this.clearViewOffsetSpy(); }
  }
  class Mesh extends Obj {
    geometry: unknown;
    material: unknown;
    constructor(geometry?: unknown, material?: unknown) { super(); this.geometry = geometry; this.material = material; }
  }
  class AmbientLight extends Obj { constructor(public color?: number, public intensity?: number) { super(); } }
  class DirectionalLight extends Obj { constructor(public color?: number, public intensity?: number) { super(); } }
  const THREE = { Scene, Group, Mesh, PerspectiveCamera, AmbientLight, DirectionalLight, Box3: Box3Stub, Vector3: Vec3Stub } as unknown as typeof import("three");
  const shared: SharedThreeRenderer = {
    renderer: { setSize: setSizeSpy, render: renderSpy, domElement } as unknown as SharedThreeRenderer["renderer"],
    dispose: vi.fn(),
  };
  return { THREE, shared, renderSpy, setSizeSpy, domElement };
}

function makeFont(): LoadedFontLike {
  return { getAdvanceWidth: () => 0.6 };
}

function baseOverlay(extra: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "ov",
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 800, height: 200 },
    z: 1,
    opacity: 1,
    content: "Hi there",
    font: "64px Inter",
    color: "#ffffff",
    align: "center",
    threeD: { depth: 4 },
    ...extra,
  };
}

function makeDeps(resolution: FontResolution): { deps: BuildTextThreeDeps; meshSpy: ReturnType<typeof vi.fn>; fauxSpy: ReturnType<typeof vi.fn>; THREE: typeof import("three"); shared: SharedThreeRenderer; renderSpy: ReturnType<typeof vi.fn>; setSizeSpy: ReturnType<typeof vi.fn>; domElement: unknown } {
  const { THREE, shared, renderSpy, setSizeSpy, domElement } = makeFakeThree();
  const Obj = (THREE as unknown as { Group: new () => import("three").Object3D }).Group;
  const meshSpy = vi.fn(() => new Obj() as unknown as import("three").Object3D);
  const fauxSpy = vi.fn(() => new Obj() as unknown as import("three").Object3D);
  const deps: BuildTextThreeDeps = {
    resolveFont: () => resolution,
    loadFont: vi.fn(async () => makeFont()),
    buildGlyphMesh: meshSpy,
    buildGlyphFaux: fauxSpy,
    importThree: async () => THREE,
  };
  return { deps, meshSpy, fauxSpy, THREE, shared, renderSpy, setSizeSpy, domElement };
}

/** A fake-three + shared renderer + a bare mesh spy the caller wires up. */
function makeMeshDeps(): { THREE: typeof import("three"); shared: SharedThreeRenderer; meshSpy: ReturnType<typeof vi.fn> } {
  const { THREE, shared } = makeFakeThree();
  const meshSpy = vi.fn();
  return { THREE, shared, meshSpy };
}


/** A premium (file-resolved) deps object wired to a caller-supplied mesh spy. */
function makeMeshDepsFor(THREE: typeof import("three"), meshSpy: ReturnType<typeof vi.fn>): BuildTextThreeDeps {
  return {
    resolveFont: () => ({ kind: "file", path: "/f.ttf", source: "bundled" }),
    loadFont: vi.fn(async () => makeFont()),
    buildGlyphMesh: meshSpy as unknown as BuildTextThreeDeps["buildGlyphMesh"],
    buildGlyphFaux: vi.fn(),
    importThree: async () => THREE,
  };
}

/** A recordable MeshStandardMaterial-like: `color.set/getHexString` + opacity.
 *  Mirrors the surface build-text-three's setColor/setOpacity closures touch. */
function makeColorMaterial(hex = "ffffff"): {
  color: { hex: string; set: (c: string) => void; getHexString: () => string };
  transparent: boolean;
  opacity: number;
} {
  return {
    color: {
      hex,
      set(c: string) { this.hex = c.replace(/^#/, "").toLowerCase(); },
      getHexString() { return this.hex; },
    },
    transparent: false,
    opacity: 1,
  };
}

/** Premium deps whose glyph meshes carry FRESH per-glyph `material: [front, side]`
 *  arrays (exactly as buildExtrudedMesh does) so color/opacity mutation is
 *  observable in tests. */
function makeColorMeshDeps(): { deps: BuildTextThreeDeps; meshSpy: ReturnType<typeof vi.fn>; shared: SharedThreeRenderer } {
  const { THREE, shared } = makeFakeThree();
  const Mesh = (THREE as unknown as { Mesh: new (g?: unknown, m?: unknown) => import("three").Object3D }).Mesh;
  const meshSpy = vi.fn(() => new Mesh(undefined, [makeColorMaterial(), makeColorMaterial()]));
  const deps: BuildTextThreeDeps = {
    resolveFont: () => ({ kind: "file", path: "/f.ttf", source: "bundled" }),
    loadFont: vi.fn(async () => makeFont()),
    buildGlyphMesh: meshSpy as unknown as BuildTextThreeDeps["buildGlyphMesh"],
    buildGlyphFaux: vi.fn(),
    importThree: async () => THREE,
  };
  return { deps, meshSpy, shared };
}

beforeEach(() => { lastCamera.current = null; });

describe("buildTextThreeInstance", () => {
  it("returns the ThreeOverlayInstance shape (render/dispose/ready/applyTransform)", async () => {
    const { deps, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(baseOverlay(), deps, shared);
    await inst.ready;
    expect(typeof inst.render).toBe("function");
    expect(typeof inst.dispose).toBe("function");
    expect(typeof inst.applyTransform).toBe("function");
    expect(inst.ready).toBeInstanceOf(Promise);
  });

  it("uses the PREMIUM glyph-mesh builder for a resolved font file", async () => {
    const { deps, meshSpy, fauxSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    await buildTextThreeInstance(baseOverlay({ content: "Hi" }), deps, shared);
    // "Hi" → 2 visible glyphs → 2 mesh builds, 0 faux.
    expect(meshSpy).toHaveBeenCalledTimes(2);
    expect(fauxSpy).not.toHaveBeenCalled();
    expect(deps.loadFont).toHaveBeenCalledWith("/f.ttf");
  });

  it("uses the FAUX builder for a name-only (faux) resolution", async () => {
    const { deps, meshSpy, fauxSpy, shared } = makeDeps({ kind: "faux", reason: "no-file" });
    await buildTextThreeInstance(baseOverlay({ content: "Hi" }), deps, shared);
    expect(fauxSpy).toHaveBeenCalledTimes(2);
    expect(meshSpy).not.toHaveBeenCalled();
    expect(deps.loadFont).not.toHaveBeenCalled();
  });

  it("falls back to the FAUX builder when the font fails to load/parse", async () => {
    // An uploaded fontFileId pointing at non-font bytes resolves as a "file" but
    // opentype.parse throws — the build must downgrade to faux, not fail.
    const { deps, meshSpy, fauxSpy, shared } = makeDeps({ kind: "file", path: "/api/files/by-id/bad/content", source: "uploaded" });
    (deps.loadFont as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not a font"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inst = await buildTextThreeInstance(baseOverlay({ content: "Hi" }), deps, shared);
    expect(inst).toBeTruthy();
    expect(fauxSpy).toHaveBeenCalledTimes(2);
    expect(meshSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("render() sizes the shared renderer and returns its domElement", async () => {
    const { deps, shared, renderSpy, setSizeSpy, domElement } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(baseOverlay(), deps, shared);
    const out = inst.render(640, 360, 640, 360, 0, 0);
    expect(setSizeSpy).toHaveBeenCalledWith(640, 360, false);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(out).toBe(domElement);
  });

  it("typewriter reveal hides later glyphs at progress 0 and shows all at 1", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "abcd", reveal: { mode: "typewriter" } }),
      deps,
      shared,
    );
    expect(typeof inst.update).toBe("function");
    // 4 glyph objects were built; capture them from the spy returns.
    const glyphObjs = meshSpy.mock.results.map((r) => r.value as { visible: boolean });
    expect(glyphObjs).toHaveLength(4);

    inst.update!({ frame: 0, time: 0, totalFrames: 60, duration: 2, progress: 0 });
    expect(glyphObjs.every((g) => g.visible === false)).toBe(true);

    inst.update!({ frame: 30, time: 1, totalFrames: 60, duration: 2, progress: 0.5 });
    expect(glyphObjs.filter((g) => g.visible).length).toBe(2); // floor(0.5*4)

    inst.update!({ frame: 60, time: 2, totalFrames: 60, duration: 2, progress: 1 });
    expect(glyphObjs.every((g) => g.visible)).toBe(true);
  });

  it("no reveal ⇒ update is undefined (everything stays visible)", async () => {
    const { deps, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(baseOverlay(), deps, shared);
    expect(inst.update).toBeUndefined();
  });

  // ── Voice sync: when api.words is present, the word-indexed 3D reveals drive
  //    off real per-word timings, NOT the linear even-spacing progress. ──
  it("karaoke emphasizes the SPOKEN word from word timings (opposite of progress)", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "karaoke" } }),
      deps,
      shared,
    );
    // "ab cd" → glyphs a,b (word 0) then c,d (word 1); the space builds no mesh.
    const g = meshSpy.mock.results.map((r) => r.value as { scale: { x: number } });
    expect(g).toHaveLength(4);
    // A big pause: word 0 spoken [0,0.4], word 1 not until [1.6,2.0].
    const words = [
      { text: "ab", start: 0, end: 0.4 },
      { text: "cd", start: 1.6, end: 2.0 },
    ];
    // At t=1.0 (mid-pause) the SPOKEN word is still 0. Linear progress (0.5)
    // would wrongly emphasize word 1 — this is the drift we're eliminating.
    inst.update!({ frame: 30, time: 1.0, totalFrames: 60, duration: 2, progress: 0.5, words });
    expect(g[0].scale.x).toBeCloseTo(1.18, 5); // "a" — word 0 emphasized
    expect(g[2].scale.x).toBeCloseTo(1.0, 5); // "c" — word 1 at rest
  });

  it("without word times, karaoke falls back to progress (word 1 at progress 0.5)", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "karaoke" } }),
      deps,
      shared,
    );
    const g = meshSpy.mock.results.map((r) => r.value as { scale: { x: number } });
    inst.update!({ frame: 30, time: 1.0, totalFrames: 60, duration: 2, progress: 0.5 });
    // Even-spacing: floor(0.5 * 2) = word 1 emphasized (the legacy behavior).
    expect(g[2].scale.x).toBeCloseTo(1.18, 5);
    expect(g[0].scale.x).toBeCloseTo(1.0, 5);
  });

  it("typewriter reveals only the spoken-so-far glyphs from word times", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "typewriter" } }),
      deps,
      shared,
    );
    const g = meshSpy.mock.results.map((r) => r.value as { visible: boolean });
    const words = [
      { text: "ab", start: 0, end: 0.4 },
      { text: "cd", start: 1.6, end: 2.0 },
    ];
    // t=1.3 (before "cd" starts): only "ab" (2 glyphs) shown. Linear progress
    // (0.65 → round(0.65*4)=3) would have shown 3.
    inst.update!({ frame: 39, time: 1.3, totalFrames: 60, duration: 2, progress: 0.65, words });
    expect(g.filter((x) => x.visible).length).toBe(2);
  });

  // ── Task 3: true reveal parity — karaoke highlightColor + real fade-words opacity ──
  it("karaoke: active word glyphs get highlightColor; others keep base color", async () => {
    const { deps, meshSpy, shared } = makeColorMeshDeps();
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "make it pop", reveal: { mode: "karaoke", highlightColor: "#ffd700" } }),
      deps,
      shared,
    );
    // "make it pop" → glyphs m,a,k,e (word0) | i,t (word1) | p,o,p (word2) = 9 meshes.
    const m = meshSpy.mock.results.map((r) => r.value as { scale: { x: number }; material: { color: { getHexString(): string } }[] });
    expect(m).toHaveLength(9);
    // No word times ⇒ progress fallback: activeWordIndexByProgress(3, 0.5) = word 1 ("it").
    inst.update!({ frame: 30, time: 1, totalFrames: 60, duration: 2, progress: 0.5 });
    // word 1 = glyph indices 4,5 → highlight color.
    expect(m[4].material[0].color.getHexString()).toBe("ffd700");
    expect(m[5].material[0].color.getHexString()).toBe("ffd700");
    // Both materials (front + side) recolored on the active glyph.
    expect(m[4].scale.x).toBeCloseTo(1.18, 5);
    // Other words keep the base color.
    expect(m[0].material[0].color.getHexString()).toBe("ffffff");
    expect(m[8].material[0].color.getHexString()).toBe("ffffff");
  });

  it("fade-words: per-glyph opacity follows fadeWordsAlphaByTime with word timings", async () => {
    const { deps, meshSpy, shared } = makeColorMeshDeps();
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "make it pop", reveal: { mode: "fade-words" } }),
      deps,
      shared,
    );
    const m = meshSpy.mock.results.map((r) => r.value as { visible: boolean; material: { opacity: number }[] });
    const words = [
      { text: "make", start: 0, end: 0.5 },
      { text: "it", start: 0.5, end: 1.0 },
      { text: "pop", start: 1.0, end: 1.5 },
    ];
    // t=0.52 (+0.08 lead → 0.60): word0 fully in (1), word1 mid-ramp (0<a<1),
    // word2 not started (0 → invisible). Real opacity, NOT a scale stand-in.
    inst.update!({ frame: 16, time: 0.52, totalFrames: 60, duration: 2, progress: 0.26, words });
    expect(m[0].material[0].opacity).toBeCloseTo(1, 5); // word0 glyph "m"
    expect(m[4].material[0].opacity).toBeGreaterThan(0); // word1 glyph "i"
    expect(m[4].material[0].opacity).toBeLessThan(1);
    expect(m[6].visible).toBe(false); // word2 glyph "p" — invisible while alpha 0
  });

  it("karaoke without highlightColor falls back to scale-only (no color writes)", async () => {
    const { deps, meshSpy, shared } = makeColorMeshDeps();
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "make it pop", reveal: { mode: "karaoke" } }),
      deps,
      shared,
    );
    const m = meshSpy.mock.results.map((r) => r.value as { scale: { x: number }; material: { color: { getHexString(): string } }[] });
    inst.update!({ frame: 30, time: 1, totalFrames: 60, duration: 2, progress: 0.5 });
    // Active word ("it") still scaled up…
    expect(m[4].scale.x).toBeCloseTo(1.18, 5);
    // …but NO color written anywhere — every glyph keeps its base color.
    expect(m.every((x) => x.material[0].color.getHexString() === "ffffff")).toBe(true);
  });

  // ── Step 4: lock each remaining mode's observable against its 2D contract ──
  it("word-current shows ONLY the active word's glyphs (2D parity)", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "word-current" } }),
      deps,
      shared,
    );
    const g = meshSpy.mock.results.map((r) => r.value as { visible: boolean });
    // activeWordIndexByProgress(2, 0.5) = word 1 → only c,d visible.
    inst.update!({ frame: 30, time: 1, totalFrames: 60, duration: 2, progress: 0.5 });
    expect(g[0].visible).toBe(false);
    expect(g[1].visible).toBe(false);
    expect(g[2].visible).toBe(true);
    expect(g[3].visible).toBe(true);
  });

  it("slide-up: all words visible at rest position (dy→0) at progress 1", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "slide-up" } }),
      deps,
      shared,
    );
    const g = meshSpy.mock.results.map((r) => r.value as { visible: boolean; position: { y: number } });
    inst.update!({ frame: 60, time: 2, totalFrames: 60, duration: 2, progress: 1 });
    expect(g.every((x) => x.visible)).toBe(true);
    for (const x of g) expect(x.position.y).toBeCloseTo(0, 5); // baseY, dy=0
  });

  it("pop: all words visible at unit scale at progress 1", async () => {
    const { deps, meshSpy, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    const inst = await buildTextThreeInstance(
      baseOverlay({ content: "ab cd", reveal: { mode: "pop" } }),
      deps,
      shared,
    );
    const g = meshSpy.mock.results.map((r) => r.value as { visible: boolean; scale: { x: number } });
    inst.update!({ frame: 60, time: 2, totalFrames: 60, duration: 2, progress: 1 });
    expect(g.every((x) => x.visible)).toBe(true);
    for (const x of g) expect(x.scale.x).toBeCloseTo(1, 5); // easeOutBack(1) = 1
  });
});

describe("FIX A: contentBoundsNDC clears stale viewOffset (base-frame measurement)", () => {
  it("clearViewOffset is called during contentBoundsNDC after a super-frame render", async () => {
    const { THREE, shared } = makeFakeThree();
    const deps: BuildTextThreeDeps = {
      resolveFont: () => ({ kind: "faux", reason: "no-file" }),
      loadFont: vi.fn(async () => makeFont()),
      buildGlyphMesh: vi.fn(),
      buildGlyphFaux: vi.fn(() => new (THREE as unknown as { Group: new () => import("three").Object3D }).Group()),
      importThree: async () => THREE,
    };
    const inst = await buildTextThreeInstance(baseOverlay({ content: "hi" }), deps, shared);

    // Simulate a super-frame render that leaves setViewOffset on the camera.
    inst.render(640, 360, 1280, 720, 320, 180);
    expect(lastCamera.current!.setViewOffsetSpy).toHaveBeenCalled();

    // Reset the spy so we can clearly assert it was called again inside contentBoundsNDC.
    lastCamera.current!.clearViewOffsetSpy.mockClear();
    lastCamera.current!.updateProjectionMatrixSpy.mockClear();

    // contentBoundsNDC must clear the stale offset before projecting.
    // (Optional on ThreeOverlayInstance — the 3D-text instance always provides it.)
    inst.contentBoundsNDC!();
    expect(lastCamera.current!.clearViewOffsetSpy).toHaveBeenCalled();
    expect(lastCamera.current!.updateProjectionMatrixSpy).toHaveBeenCalled();
  });
});

describe("buildTextThreeInstance dispose() resource lifecycle", () => {
  it("does NOT dispose shared cache-owned geometry when one of two instances sharing a glyph is disposed", async () => {
    const { THREE, shared, meshSpy } = makeMeshDeps();
    // ONE shared cached geometry whose .dispose is a spy. The mesh builder hands
    // this same object back for every glyph build (simulating the geometryCache
    // returning a shared ExtrudeGeometry for the same font|glyph|depth|bevel key).
    const sharedGeomDispose = vi.fn();
    const sharedGeometry = markCached({ dispose: sharedGeomDispose });

    const buildSharedGlyph = () => {
      const obj = new (THREE as unknown as { Mesh: new (...a: unknown[]) => import("three").Object3D }).Mesh();
      (obj as unknown as { geometry: unknown }).geometry = sharedGeometry;
      (obj as unknown as { material: { dispose: () => void } }).material = { dispose: vi.fn() };
      return obj;
    };
    meshSpy.mockImplementation(buildSharedGlyph as never);

    const depsA = makeMeshDepsFor(THREE, meshSpy);
    const depsB = makeMeshDepsFor(THREE, meshSpy);

    const instA = await buildTextThreeInstance(baseOverlay({ content: "o" }), depsA, shared);
    const instB = await buildTextThreeInstance(baseOverlay({ content: "o" }), depsB, shared);

    // Dispose A — must NOT free the shared geometry B still uses.
    instA.dispose();
    expect(sharedGeomDispose).not.toHaveBeenCalled();

    // B is still renderable (geometry not freed).
    expect(() => instB.render(100, 100, 100, 100, 0, 0)).not.toThrow();
    instB.dispose();
    expect(sharedGeomDispose).not.toHaveBeenCalled();
  });

  it("disposes per-instance (non-cached) geometry on dispose", async () => {
    const { THREE, shared, meshSpy } = makeMeshDeps();
    const perInstanceDispose = vi.fn();
    meshSpy.mockImplementation((() => {
      const obj = new (THREE as unknown as { Mesh: new (...a: unknown[]) => import("three").Object3D }).Mesh();
      // NOT marked cached → it's a per-instance geometry, must be freed.
      (obj as unknown as { geometry: unknown }).geometry = { dispose: perInstanceDispose };
      (obj as unknown as { material: { dispose: () => void } }).material = { dispose: vi.fn() };
      return obj;
    }) as never);

    const deps = makeMeshDepsFor(THREE, meshSpy);
    const inst = await buildTextThreeInstance(baseOverlay({ content: "o" }), deps, shared);
    inst.dispose();
    expect(perInstanceDispose).toHaveBeenCalled();
  });

  it("disposes each faux CanvasText (freeing its internal texture) on dispose", async () => {
    const { THREE, shared } = makeMeshDeps();
    const fauxDisposeSpies: ReturnType<typeof vi.fn>[] = [];

    // Faux builder returns a Group whose children are CanvasText-like Meshes
    // (they HAVE .geometry) with their own .dispose() that frees the texture.
    const fauxSpy = vi.fn(() => {
      const Group = (THREE as unknown as { Group: new () => import("three").Object3D }).Group;
      const group = new Group();
      const disposeSpy = vi.fn();
      fauxDisposeSpies.push(disposeSpy);
      const canvasText = new (THREE as unknown as { Mesh: new () => import("three").Object3D }).Mesh();
      (canvasText as unknown as { geometry: { dispose: () => void } }).geometry = { dispose: vi.fn() };
      (canvasText as unknown as { material: { dispose: () => void } }).material = { dispose: vi.fn() };
      (canvasText as unknown as { isLibiCanvasText: boolean }).isLibiCanvasText = true;
      (canvasText as unknown as { dispose: () => void }).dispose = disposeSpy;
      (group as unknown as { add: (o: unknown) => void }).add(canvasText);
      return group;
    });

    const deps: BuildTextThreeDeps = {
      resolveFont: () => ({ kind: "faux", reason: "no-file" }),
      loadFont: vi.fn(async () => makeFont()),
      buildGlyphMesh: vi.fn(),
      buildGlyphFaux: fauxSpy,
      importThree: async () => THREE,
    };

    const inst = await buildTextThreeInstance(baseOverlay({ content: "ab" }), deps, shared);
    // "ab" → 2 faux glyph groups → 2 CanvasText instances.
    expect(fauxDisposeSpies).toHaveLength(2);

    inst.dispose();
    for (const spy of fauxDisposeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});

describe("billboard long-lens (flat-text perspective recession fix)", () => {
  it("billboard tilt gets a narrowed FOV + proportionally farther camera (same framing)", async () => {
    const { deps, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    await buildTextThreeInstance(baseOverlay({ threeD: { depth: 4 } }), deps, shared);
    const cam = lastCamera.current as unknown as { fov: number; position: { z: number } };
    // distance 6 -> 18; fov 50 -> 2*atan(tan(25deg)/3) ~= 17.66deg; framing invariant:
    expect(cam.position.z).toBeCloseTo(18, 6);
    expect(cam.fov).toBeCloseTo((Math.atan(Math.tan((50 * Math.PI) / 360) / 3) * 360) / Math.PI, 6);
    expect(Math.tan((cam.fov * Math.PI) / 360) * cam.position.z).toBeCloseTo(Math.tan((50 * Math.PI) / 360) * 6, 6);
  });

  it("non-billboard tilt keeps the preset camera untouched", async () => {
    const { deps, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    await buildTextThreeInstance(baseOverlay({ threeD: { depth: 4, tilt: "angled" } }), deps, shared);
    const cam = lastCamera.current as unknown as { fov: number; position: { z: number } };
    expect(cam.fov).toBe(50);
    expect(cam.position.z).toBeCloseTo(4.4, 6);
  });

  it("flythrough reveal keeps the stock billboard camera (it drives its own)", async () => {
    const { deps, shared } = makeDeps({ kind: "file", path: "/f.ttf", source: "bundled" });
    await buildTextThreeInstance(
      baseOverlay({ threeD: { depth: 4 }, reveal: { mode: "flythrough" } }),
      deps, shared,
    );
    const cam = lastCamera.current as unknown as { fov: number; position: { z: number } };
    expect(cam.fov).toBe(50);
    expect(cam.position.z).toBeCloseTo(6, 6);
  });
});
