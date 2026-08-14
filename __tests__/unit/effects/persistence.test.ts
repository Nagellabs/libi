import { describe, it, expect } from "vitest";
import { layerEffectsSchema } from "@/mcp/tools/schemas";
import type { LayerEffects } from "@/lib/effects/types";
import type { TextOverlay } from "@/lib/engine/types";

describe("layerEffectsSchema", () => {
  it("accepts a valid in/out/loop block", () => {
    const parsed = layerEffectsSchema.parse({
      in: { effectId: "fade", durationMs: 400 },
      loop: { effectId: "pulse", params: { amount: 0.06 } },
    });
    expect(parsed.in?.effectId).toBe("fade");
    expect(parsed.loop?.params?.amount).toBe(0.06);
  });
  it("rejects a non-string effectId", () => {
    expect(() => layerEffectsSchema.parse({ in: { effectId: 5 } })).toThrow();
  });
});

it("effects survive an overlay JSON round-trip", () => {
  const fx: LayerEffects = { in: { effectId: "fade", durationMs: 400 } };
  const overlay = {
    id: "o",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    opacity: 1,
    content: "x",
    font: "10px Inter",
    color: "#fff",
    align: "left",
    effects: fx,
  } as TextOverlay;
  const round = JSON.parse(JSON.stringify(overlay)) as TextOverlay;
  expect(round.effects?.in?.effectId).toBe("fade");
});
