import { describe, it, expect } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition } from "@/lib/engine/types";

function videoComp(overlays: Composition["overlays"]): Composition {
  return {
    id: "c", name: "c", width: 1280, height: 720, fps: 30,
    overlays: [
      // Base video is an OVERLAY now; z:-1 keeps it below the fixtures' z:0
      // overlays so `resolveExportBase` still picks it as the base.
      {
        id: "s1", kind: "video", fileId: "f1",
        startTime: 0, duration: 4, z: -1, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 1280, height: 720 },
        sourceWidth: 1280, sourceHeight: 720,
      } as never,
      ...(overlays ?? []),
    ],
  };
}

describe("classifier: three overlays route to chromium-render", () => {
  it("a single-video comp with a three overlay does NOT take the ffmpeg fast path", () => {
    const shape = classifyExportShape(
      videoComp([
        { id: "t1", kind: "three", startTime: 0, duration: 4, z: 0, opacity: 1,
          rect: { x: 0, y: 0, width: 1280, height: 720 }, sceneFunction: "return () => {};" } as never,
      ]),
    );
    expect(shape.tag).toBe("chromium-render");
  });
});
