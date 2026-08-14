// __tests__/unit/export/classifier-custom-effects.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import { registerCustomEffects, clearCustomEffects } from "@/lib/effects/registry";
import type { EffectDef } from "@/lib/effects/types";
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
    scenes: [],
    audioClips: [],
    ...overrides,
    // Base video is an OVERLAY now. Prepended below the caller's overlays
    // (z:-1) so it is always the resolved export base.
    overlays: [BASE_VIDEO, ...(overrides.overlays ?? [])],
  } as Composition;
}

/** A registered custom VISUAL effect (no audioEnvelope flag). */
const CUSTOM_VISUAL: EffectDef = {
  meta: {
    id: "slow-drift",
    name: "Slow Drift",
    family: "animation",
    phases: ["loop"],
    supports: ["scene", "text"],
    params: [],
  },
  animate: (progress) => ({ dx: progress * 10 }),
};

describe("export routing for custom + unknown effects", () => {
  // Force fallbackShape() → canvas-source for deterministic tag assertions
  beforeEach(() => {
    process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = "1";
  });
  afterEach(() => {
    delete process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
    clearCustomEffects();
  });

  it("a REGISTERED custom visual effect on the scene forces canvas-source", () => {
    registerCustomEffects([CUSTOM_VISUAL]);
    const c = comp({
      scenes: [
        {
          id: "s", name: "s", type: "video", duration: 4, fileId: "f", videoUrl: "/x",
          effects: { loop: { effectId: "slow-drift" } },
        } as never,
      ],
    });
    expect(classifyExportShape(c).tag).toBe("canvas-source");
  });

  it("an UNKNOWN/unregistered effectId on a layer also forces canvas-source (conservative)", () => {
    // No registerCustomEffects — the id resolves to nothing.
    const c = comp({
      overlays: [
        {
          id: "o", kind: "text", startTime: 0, duration: 2, z: 0,
          rect: { x: 0, y: 0, width: 10, height: 10 }, opacity: 1,
          content: "x", font: "10px Inter", color: "#fff", align: "left",
          effects: { in: { effectId: "totally-unknown-effect" } },
        } as never,
      ],
    });
    expect(classifyExportShape(c).tag).toBe("canvas-source");
  });

  it("a registered AUDIO-envelope effect still does NOT force canvas-source", () => {
    const c = comp({
      audioClips: [
        {
          id: "a", kind: "standalone", fileId: "f", startTime: 0, duration: 4,
          trimStart: 0, volume: 1, enabled: true,
          effects: { in: { effectId: "audio-fade-in" } },
        } as never,
      ],
    });
    expect(classifyExportShape(c).tag).not.toBe("canvas-source");
  });
});
