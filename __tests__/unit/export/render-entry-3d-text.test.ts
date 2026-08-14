import { describe, it, expect, vi } from "vitest";
import {
  overlayNeedsThreeInstance,
  buildOverlayThreeScenesWithDeps,
  type BuildOverlayThreeDeps,
} from "@/lib/export/render-entry-three";
import type {
  Overlay,
  TextOverlay,
  ThreeOverlay,
  ImageOverlay,
} from "@/lib/engine/types";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";

function textOverlay(extra: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "txt",
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 800, height: 200 },
    z: 1,
    opacity: 1,
    content: "Hello",
    font: "64px Inter",
    color: "#ffffff",
    align: "center",
    ...extra,
  };
}

function threeOverlay(extra: Partial<ThreeOverlay> = {}): ThreeOverlay {
  return {
    id: "three",
    kind: "three",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 800, height: 200 },
    z: 1,
    opacity: 1,
    sceneFunction: "/* body */",
    ...extra,
  };
}

function imageOverlay(extra: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "img",
    kind: "image",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 800, height: 200 },
    z: 1,
    opacity: 1,
    fileId: "f1",
    ...extra,
  };
}

/** A fake ThreeOverlayInstance — just the dispose surface the builder touches. */
function fakeInstance(): ThreeOverlayInstance {
  return {
    ready: Promise.resolve(),
    render: vi.fn(),
    dispose: vi.fn(),
    applyTransform: vi.fn(),
  } as unknown as ThreeOverlayInstance;
}

describe("overlayNeedsThreeInstance (export 3D-overlay classifier)", () => {
  it("returns true for a `three` overlay", () => {
    expect(overlayNeedsThreeInstance(threeOverlay())).toBe(true);
  });

  it("returns true for a `text` overlay carrying threeD", () => {
    expect(overlayNeedsThreeInstance(textOverlay({ threeD: { depth: 4 } }))).toBe(true);
  });

  it("returns false for a plain `text` overlay (no threeD)", () => {
    expect(overlayNeedsThreeInstance(textOverlay())).toBe(false);
  });

  it("returns true for place3d-only text (no threeD) — shared gate parity", () => {
    expect(overlayNeedsThreeInstance(textOverlay({ place3d: true }))).toBe(true);
  });

  it("returns false for a non-3D kind (image)", () => {
    expect(overlayNeedsThreeInstance(imageOverlay())).toBe(false);
  });
});

describe("buildOverlayThreeScenesWithDeps", () => {
  function makeDeps(): {
    deps: BuildOverlayThreeDeps;
    buildThreeSpy: ReturnType<typeof vi.fn>;
    buildTextSpy: ReturnType<typeof vi.fn>;
    sharedDispose: ReturnType<typeof vi.fn>;
  } {
    const buildThreeSpy = vi.fn(async () => fakeInstance());
    const buildTextSpy = vi.fn(async () => fakeInstance());
    const sharedDispose = vi.fn();
    const deps: BuildOverlayThreeDeps = {
      createSharedThreeRenderer: vi.fn(async () => ({
        renderer: {} as never,
        dispose: sharedDispose,
      })),
      buildThreeInstance: buildThreeSpy as never,
      buildTextThreeInstance: buildTextSpy as never,
      makeBrowserTextThreeDeps: vi.fn(() => ({} as never)),
    };
    return { deps, buildThreeSpy, buildTextSpy, sharedDispose };
  }

  it("builds an instance for a `three` overlay AND a `text+threeD` overlay", async () => {
    const { deps, buildThreeSpy, buildTextSpy } = makeDeps();
    const overlays: Overlay[] = [
      threeOverlay({ id: "t3" }),
      textOverlay({ id: "txt3d", threeD: { depth: 4 } }),
    ];
    const { scenes } = await buildOverlayThreeScenesWithDeps(overlays, deps);

    expect(buildThreeSpy).toHaveBeenCalledTimes(1);
    expect(buildTextSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(scenes).sort()).toEqual(["t3", "txt3d"]);
    // keyed by overlay.id
    expect(scenes["t3"]).toBeDefined();
    expect(scenes["txt3d"]).toBeDefined();
  });

  it("builds for place3d-only text (no threeD) and passes a synthesized depth:0 threeD to the builder", async () => {
    const { deps, buildTextSpy } = makeDeps();
    const overlays: Overlay[] = [textOverlay({ id: "txtP3d", place3d: true })];
    const { scenes } = await buildOverlayThreeScenesWithDeps(overlays, deps);

    expect(buildTextSpy).toHaveBeenCalledTimes(1);
    // The builder requires a threeD block; the shared synthesis helper supplies
    // a flat default so export renders 3D just like preview.
    const passedOverlay = buildTextSpy.mock.calls[0][0] as TextOverlay;
    expect(passedOverlay.threeD).toEqual({ depth: 0 });
    expect(Object.keys(scenes)).toEqual(["txtP3d"]);
    // Source overlay untouched — synthesis is build-time only.
    expect((overlays[0] as TextOverlay).threeD).toBeUndefined();
  });

  it("does NOT build for a plain `text` overlay (no threeD) or an image overlay", async () => {
    const { deps, buildThreeSpy, buildTextSpy } = makeDeps();
    const overlays: Overlay[] = [textOverlay(), imageOverlay()];
    const { scenes } = await buildOverlayThreeScenesWithDeps(overlays, deps);

    expect(buildThreeSpy).not.toHaveBeenCalled();
    expect(buildTextSpy).not.toHaveBeenCalled();
    expect(Object.keys(scenes)).toEqual([]);
  });

  it("no-ops (no shared renderer created) when there are zero 3D overlays", async () => {
    const { deps } = makeDeps();
    const overlays: Overlay[] = [imageOverlay()];
    const { scenes, dispose } = await buildOverlayThreeScenesWithDeps(overlays, deps);
    expect(deps.createSharedThreeRenderer).not.toHaveBeenCalled();
    expect(scenes).toEqual({});
    expect(typeof dispose).toBe("function");
    dispose(); // safe to call
  });

  it("dispose() frees every built instance + the shared renderer", async () => {
    const { deps, sharedDispose } = makeDeps();
    const inst3 = fakeInstance();
    const instText = fakeInstance();
    (deps.buildThreeInstance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(inst3);
    (deps.buildTextThreeInstance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(instText);
    const overlays: Overlay[] = [
      threeOverlay({ id: "t3" }),
      textOverlay({ id: "txt3d", threeD: { depth: 4 } }),
    ];
    const { dispose } = await buildOverlayThreeScenesWithDeps(overlays, deps);
    dispose();
    expect(inst3.dispose).toHaveBeenCalledTimes(1);
    expect(instText.dispose).toHaveBeenCalledTimes(1);
    expect(sharedDispose).toHaveBeenCalledTimes(1);
  });
});
