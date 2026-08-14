// __tests__/unit/effects/compose.test.ts
import { describe, it, expect } from "vitest";
import { composeEffects, type ComposeInput } from "@/lib/effects/compose";
import type { EffectDef } from "@/lib/effects/types";

const fade: EffectDef = {
  meta: { id: "fade", name: "Fade", family: "animation", phases: ["in", "out"], supports: ["text"], params: [] },
  animate: (p) => ({ opacity: p }),
};
const zoom: EffectDef = {
  meta: { id: "zoom", name: "Zoom", family: "animation", phases: ["in"], supports: ["text"], params: [] },
  animate: (p) => ({ scale: 0.5 + 0.5 * p }),
};
// A custom-style effect whose animate reads a param directly (like an authored
// animate.js) — used to prove param-default merging. `scale` is param-only so the
// loop phase value is irrelevant.
const paramEffect: EffectDef = {
  meta: {
    id: "param",
    name: "Param",
    family: "animation",
    phases: ["loop"],
    supports: ["image"],
    params: [{ key: "amount", label: "Amount", type: "number", default: 0.4 }],
    defaultDurationMs: 1600,
  },
  animate: (_p, params) => ({ scale: params.amount as number }),
};
const resolve = (id: string) => ({ fade, zoom, param: paramEffect }[id]);

describe("composeEffects", () => {
  it("merges an effect's declared param defaults when the applied ref omits params", () => {
    // The common case: apply_layer_effect stores just `{ effectId }`. Without the
    // merge, animate would read params.amount === undefined → NaN scale → no anim.
    const d = composeEffects(
      { effects: { loop: { effectId: "param" } }, globalTime: 3, startTime: 2, duration: 4 },
      resolve,
    );
    expect(d.scale).toBeCloseTo(0.4, 5);
    expect(Number.isNaN(d.scale as number)).toBe(false);
  });

  it("a ref param overrides the effect's declared default", () => {
    const d = composeEffects(
      {
        effects: { loop: { effectId: "param", params: { amount: 0.2 } } },
        globalTime: 3, startTime: 2, duration: 4,
      },
      resolve,
    );
    expect(d.scale).toBeCloseTo(0.2, 5);
  });

  it("identity when no effects", () => {
    const input: ComposeInput = { effects: undefined, globalTime: 3, startTime: 2, duration: 4 };
    expect(composeEffects(input, resolve)).toEqual({});
  });

  it("in-fade at window midpoint yields opacity 0.5", () => {
    const input: ComposeInput = {
      effects: { in: { effectId: "fade", durationMs: 1000 } },
      globalTime: 2.5, startTime: 2, duration: 4,
    };
    expect(composeEffects(input, resolve).opacity).toBeCloseTo(0.5, 5);
  });

  it("scales multiply and opacities multiply across slots", () => {
    const input: ComposeInput = {
      effects: {
        in: { effectId: "zoom", durationMs: 1000 },   // at p=1 → scale 1
        loop: { effectId: "fade", durationMs: 2000 }, // loop fade as opacity wobble
      },
      globalTime: 3.0, startTime: 2, duration: 4,
    };
    const d = composeEffects(input, resolve);
    expect(d.scale).toBeCloseTo(1, 5);            // zoom settled
    expect(d.opacity).toBeGreaterThan(0);          // loop contributes opacity
  });

  it("unknown effectId is skipped (no throw)", () => {
    const input: ComposeInput = {
      effects: { in: { effectId: "nope" } },
      globalTime: 3, startTime: 2, duration: 4,
    };
    expect(composeEffects(input, resolve)).toEqual({});
  });

  it("out slot is the time-reverse of in (fade out → opacity 1 at out-start, 0 at end)", () => {
    // element [2,6]; out window 1s ⇒ out-start at t=5, end at t=6.
    const atOutStart: ComposeInput = {
      effects: { out: { effectId: "fade", durationMs: 1000 } },
      globalTime: 5, startTime: 2, duration: 4,
    };
    const atEnd: ComposeInput = { ...atOutStart, globalTime: 6 };
    expect(composeEffects(atOutStart, resolve).opacity).toBeCloseTo(1, 5); // still visible
    expect(composeEffects(atEnd, resolve).opacity).toBeCloseTo(0, 5);      // faded out
  });

  it("propagates clipReveal from an effect to the composed delta", () => {
    const wipeLike = {
      meta: { id: "wipeLike", name: "W", family: "animation" as const, phases: ["in"] as ("in")[], supports: ["text" as const], params: [] },
      animate: (p: number) => (p >= 1 ? {} : { clipReveal: { edge: "left" as const, fraction: 0.3 } }),
    };
    const r = (id: string) => (id === "wipeLike" ? wipeLike : undefined);
    const d = composeEffects({ effects: { in: { effectId: "wipeLike", durationMs: 1000 } }, globalTime: 2.5, startTime: 2, duration: 4 }, r);
    expect(d.clipReveal).toEqual({ edge: "left", fraction: 0.3 });
  });
});
