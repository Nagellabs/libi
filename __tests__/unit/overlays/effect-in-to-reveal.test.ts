import { describe, it, expect } from "vitest";
import { effectInToReveal } from "@/lib/overlays/hydrate";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

function textOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "t1",
    kind: "text",
    startTime: 0,
    duration: 20,
    z: 1,
    opacity: 1,
    rect: { x: 0, y: 0, width: 400, height: 100 },
    content: "test",
    ...over,
  } as TextOverlay;
}

describe("effectInToReveal (effects.in → reveal bridge)", () => {
  it("synthesizes a reveal from a mapped effects.in effect, with fraction from durationMs", () => {
    const o = textOverlay({ duration: 20, effects: { in: { effectId: "typewriter", durationMs: 800 } } });
    const out = effectInToReveal(o) as TextOverlay;
    expect(out.reveal?.mode).toBe("typewriter");
    // 800ms over a 20s window = 0.04 of the clip.
    expect(out.reveal?.fraction).toBeCloseTo(0.04, 4);
  });

  it("maps the slide-up-lines EFFECT id to the slide-up reveal MODE", () => {
    const o = textOverlay({ effects: { in: { effectId: "slide-up-lines", durationMs: 500 } } });
    expect((effectInToReveal(o) as TextOverlay).reveal?.mode).toBe("slide-up");
  });

  it("omits fraction when durationMs is absent (reveal spans the window)", () => {
    const o = textOverlay({ effects: { in: { effectId: "typewriter" } } });
    const out = effectInToReveal(o) as TextOverlay;
    expect(out.reveal?.mode).toBe("typewriter");
    expect(out.reveal?.fraction).toBeUndefined();
  });

  it("does NOT clobber an explicit reveal (reveal wins)", () => {
    const o = textOverlay({
      reveal: { mode: "fade-words" },
      effects: { in: { effectId: "typewriter", durationMs: 800 } },
    });
    expect((effectInToReveal(o) as TextOverlay).reveal?.mode).toBe("fade-words");
  });

  it("is a no-op for an unmapped effect id", () => {
    const o = textOverlay({ effects: { in: { effectId: "bounce", durationMs: 400 } } });
    expect((effectInToReveal(o) as TextOverlay).reveal).toBeUndefined();
  });

  it("is a no-op for a non-text overlay", () => {
    const img = {
      id: "i1", kind: "image", startTime: 0, duration: 5, z: 1, opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 }, fileId: "f1",
      effects: { in: { effectId: "typewriter", durationMs: 800 } },
    } as unknown as Overlay;
    expect(effectInToReveal(img)).toBe(img);
  });

  it("clamps a tiny durationMs to a minimum visible fraction", () => {
    const o = textOverlay({ duration: 100, effects: { in: { effectId: "typewriter", durationMs: 1 } } });
    // 1ms / 100s = 0.00001 → clamped up to 0.01 so the reveal is observable.
    expect((effectInToReveal(o) as TextOverlay).reveal?.fraction).toBeCloseTo(0.01, 4);
  });
});
