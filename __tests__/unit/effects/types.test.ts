// __tests__/unit/effects/types.test.ts
import { describe, it, expect } from "vitest";
import { IDENTITY_DELTA, type LayerEffects, type EffectDef } from "@/lib/effects/types";
import type { TextOverlay, CanvasScene, AudioClip } from "@/lib/engine/types";

describe("effect types", () => {
  it("IDENTITY_DELTA is a no-op delta", () => {
    expect(IDENTITY_DELTA).toEqual({});
  });

  it("LayerEffects attaches to overlays, scenes, and audio clips", () => {
    const fx: LayerEffects = { in: { effectId: "fade", durationMs: 400 } };
    const overlay: Pick<TextOverlay, "effects"> = { effects: fx };
    const scene: Pick<CanvasScene, "effects"> = { effects: fx };
    const audio: Pick<AudioClip, "effects"> = { effects: { in: { effectId: "audio-fade-in" } } };
    expect(overlay.effects?.in?.effectId).toBe("fade");
    expect(scene.effects?.in?.durationMs).toBe(400);
    expect(audio.effects?.in?.effectId).toBe("audio-fade-in");
  });

  it("an EffectDef has meta + animate", () => {
    const def: EffectDef = {
      meta: { id: "x", name: "X", family: "animation", phases: ["in"], supports: ["text"], params: [] },
      animate: () => ({ opacity: 1 }),
    };
    expect(def.animate(0.5, {})).toEqual({ opacity: 1 });
  });
});
