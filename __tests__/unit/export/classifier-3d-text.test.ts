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

function textOverlay(extra: Record<string, unknown>) {
  return {
    id: "t1", kind: "text", startTime: 0, duration: 4, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
    content: "HELLO", font: "48px Inter", color: "#fff", align: "center",
    ...extra,
  } as never;
}

describe("classifier: 3D text overlays route to chromium-render", () => {
  it("a text overlay WITH a threeD block does NOT take the ffmpeg fast path", () => {
    const shape = classifyExportShape(
      videoComp([textOverlay({ threeD: { depth: 12, frontColor: "#fff" } })]),
    );
    expect(shape.tag).toBe("chromium-render");
  });

  it("a place3d-only text overlay (no threeD) also leaves the ffmpeg fast path", () => {
    // 3D-mode text renders through the three instance even without extrusion —
    // the drawtext fast path can't reproduce it, so it must route to the fallback.
    const shape = classifyExportShape(videoComp([textOverlay({ place3d: true })]));
    expect(shape.tag).toBe("chromium-render");
  });

  it("the SAME text overlay WITHOUT threeD keeps the ffmpeg fast path", () => {
    const shape = classifyExportShape(videoComp([textOverlay({})]));
    expect(shape.tag).toBe("ffmpeg-overlay");
  });
});
