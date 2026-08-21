// __tests__/unit/export/effects-routing.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition } from "@/lib/engine/types";

/** Full-frame base video overlay; z:-1 keeps it beneath the fixtures' z:0 overlays. */
const BASE_VIDEO = {
  id: "s", kind: "video", fileId: "f", videoUrl: "/x",
  startTime: 0, duration: 4, z: -1, opacity: 1, fit: "cover",
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  sourceWidth: 1920, sourceHeight: 1080,
} as never;

function comp(overrides: Partial<Composition>): Composition {
  return {
    id: "c", name: "c", width: 1920, height: 1080, fps: 30,
    audioClips: [],
    ...overrides,
    // Base video is an OVERLAY now. Prepended below the caller's overlays
    // (z:-1) so it is always the resolved export base.
    overlays: [BASE_VIDEO, ...(overrides.overlays ?? [])],
  } as Composition;
}

describe("export routing with effects", () => {
  // Force fallbackShape() → canvas-source for deterministic tag assertions
  beforeEach(() => { process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = "1"; });
  afterEach(() => { delete process.env.LIBI_EXPORT_USE_BROWSER_CANVAS; });

  it("an overlay with a visual effect forces canvas-source", () => {
    const c = comp({ overlays: [{ id: "o", kind: "text", startTime: 0, duration: 2, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, opacity: 1, content: "x", font: "10px Inter", color: "#fff", align: "left", effects: { in: { effectId: "fade" } } } as never] });
    expect(classifyExportShape(c).tag).toBe("canvas-source");
  });

  it("an AUDIO-only effect does NOT force canvas-source", () => {
    const c = comp({ audioClips: [{ id: "a", kind: "standalone", fileId: "f", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true, effects: { in: { effectId: "audio-fade-in" } } } as never] });
    expect(classifyExportShape(c).tag).not.toBe("canvas-source");
  });
});
