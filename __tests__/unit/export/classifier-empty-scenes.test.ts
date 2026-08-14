import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition } from "@/lib/engine/types";

function emptyScenesComp(
  overlays: Composition["overlays"],
  audioClips?: Composition["audioClips"],
): Composition {
  return {
    id: "c",
    name: "c",
    width: 1280,
    height: 720,
    fps: 30,
    scenes: [],
    overlays,
    audioClips,
  };
}

function singleVideoComp(): Composition {
  return {
    id: "c",
    name: "c",
    width: 1280,
    height: 720,
    fps: 30,
    scenes: [],
    overlays: [{
      id: "s1", kind: "video", fileId: "f1",
      startTime: 0, duration: 4, z: 0, opacity: 1, fit: "cover",
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      sourceWidth: 1280, sourceHeight: 720,
    } as never],
  };
}

describe("classifier: empty scenes routing", () => {
  it("empty scenes + one code overlay routes to the render fallback (not error, not a fast path)", () => {
    const shape = classifyExportShape(
      emptyScenesComp([
        {
          id: "o1",
          kind: "code",
          startTime: 0,
          duration: 4,
          z: 0,
          opacity: 1,
          rect: { x: 0, y: 0, width: 1280, height: 720 },
          drawFunction: "return () => {};",
        } as never,
      ]),
    );
    expect(shape.tag).toBe("chromium-render");
  });

  it("empty scenes + one text overlay routes to the render fallback (not error)", () => {
    const shape = classifyExportShape(
      emptyScenesComp([
        {
          id: "o1",
          kind: "text",
          text: "hi",
          startTime: 0,
          duration: 4,
          z: 0,
          opacity: 1,
          rect: { x: 0, y: 0, width: 200, height: 80 },
        } as never,
      ]),
    );
    expect(shape.tag).toBe("chromium-render");
    expect(shape.tag).not.toBe("ffmpeg-overlay");
    expect(shape.tag).not.toBe("stream-copy-trim");
  });

  it("empty scenes + audio clip only routes to the render fallback (not error)", () => {
    const shape = classifyExportShape(
      emptyScenesComp(undefined, [
        {
          id: "a1",
          kind: "standalone",
          fileId: "af1",
          startTime: 0,
          duration: 4,
          enabled: true,
          volume: 1,
        } as never,
      ]),
    );
    expect(shape.tag).toBe("chromium-render");
  });

  it("empty scenes + no overlays + no audio is an error ('nothing to export')", () => {
    const shape = classifyExportShape(emptyScenesComp(undefined, undefined));
    expect(shape).toEqual({ tag: "error", reason: "nothing to export" });
  });

  it("a single video scene is unchanged (regression guard)", () => {
    const shape = classifyExportShape(singleVideoComp());
    expect(shape.tag).toBe("stream-copy-trim");
  });
});
