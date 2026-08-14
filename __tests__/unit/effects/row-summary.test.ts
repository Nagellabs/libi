import { describe, it, expect } from "vitest";
import { effectRowSummary } from "@/lib/effects/row-summary";
import type { EffectDef } from "@/lib/effects/types";

function def(meta: Partial<EffectDef["meta"]>): EffectDef {
  return {
    meta: {
      id: "x",
      name: "X",
      family: "animation",
      phases: ["in", "out"],
      supports: ["text"],
      params: [],
      defaultDurationMs: 400,
      ...meta,
    },
    animate: () => ({}),
  } as EffectDef;
}

describe("effectRowSummary", () => {
  it("phase + explicit duration", () => {
    expect(effectRowSummary(def({}), { effectId: "x", durationMs: 500 }, "out")).toBe("out · 500ms");
  });

  it("falls back to the def's default duration", () => {
    expect(effectRowSummary(def({ defaultDurationMs: 400 }), { effectId: "x" }, "in")).toBe("in · 400ms");
  });

  it("appends the first enum param's effective value; number params omitted", () => {
    const d = def({
      params: [
        { key: "distance", label: "Distance", type: "number", default: 300 },
        { key: "direction", label: "Direction", type: "enum", default: "up", options: ["up", "down"] },
      ],
    });
    expect(effectRowSummary(d, { effectId: "x", durationMs: 500 }, "out")).toBe("out · 500ms · up");
    expect(effectRowSummary(d, { effectId: "x", durationMs: 500, params: { direction: "down" } }, "out"))
      .toBe("out · 500ms · down");
  });

  it("skips duration for text-internal and audio-envelope effects", () => {
    expect(effectRowSummary(def({ textInternal: true }), { effectId: "x", durationMs: 800 }, "in")).toBe("in");
    expect(effectRowSummary(def({ audioEnvelope: true }), { effectId: "x" }, "in")).toBe("in");
  });

  it("skips duration when neither ref nor def provides one", () => {
    expect(effectRowSummary(def({ defaultDurationMs: undefined }), { effectId: "x" }, "loop")).toBe("loop");
  });
});
