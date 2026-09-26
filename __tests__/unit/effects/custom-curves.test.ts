// The page's side of custom effects (lib/effects/custom-curves.ts): a
// curve-backed def never runs its body in this realm; it hands the source to a
// sampler, draws identity until the numbers arrive, then interpolates them —
// and the export waits for every curve before its first frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURVE_FIELDS, CURVE_SAMPLES, encodeDelta } from "@/lib/effects/curve";
import {
  configureEffectSampler,
  curveBackedEffect,
  prepareCustomEffectCurves,
  resetCustomEffectCurves,
  subscribeCustomEffectCurves,
  type CurveSampler,
} from "@/lib/effects/custom-curves";
import { customEffectDefsFromPayload } from "@/lib/effects/hydrate-custom-client";
import { manifestToMeta, type CustomEffectManifest } from "@/lib/effects/package-types";
import { BUILTIN_EFFECTS } from "@/lib/effects/builtin";
import type { EffectDef } from "@/lib/effects/types";

const HASH = "a".repeat(64);
const MANIFEST: CustomEffectManifest = { id: "slide", name: "Slide", family: "animation", phases: ["in", "out", "loop"], supports: ["text"], params: [{ key: "px", label: "px", type: "number", default: 100 }] };

/** A sampler that "runs" a JS function in the test — standing in for the worker. */
function fakeSampler(animate: (p: number, params: Record<string, number | string>) => unknown) {
  const calls: Array<{ effectId: string; source: string; params: Record<string, number | string> }> = [];
  const gates: Array<() => void> = [];
  const sampler: CurveSampler & { calls: typeof calls; release(): void } = {
    calls,
    sample: (req) => {
      calls.push(req);
      return new Promise((resolve) => {
        gates.push(() => {
          const out = new Float64Array(CURVE_FIELDS.length * CURVE_SAMPLES);
          for (let i = 0; i < CURVE_SAMPLES; i++) encodeDelta(animate(i / (CURVE_SAMPLES - 1), req.params), out, i, CURVE_SAMPLES);
          resolve(out);
        });
      });
    },
    destroy: vi.fn(),
    release: () => gates.splice(0).forEach((g) => g()),
  };
  return sampler;
}

afterEach(() => {
  resetCustomEffectCurves();
  vi.unstubAllGlobals();
});

describe("a hostile custom effect never runs in the page", () => {
  it("fetch / XMLHttpRequest / import() in the body: the page only forwards the source; nothing is evaluated or requested here", async () => {
    const fetchSpy = vi.fn();
    const xhrSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhrSpy);
    const g = globalThis as { __fxRan?: number };
    delete g.__fxRan;
    const hostile = [
      "var g = this; g.__fxRan = 1;",
      "g['fe' + 'tch']('/api/templates/cloud/publish-requests');",
      "new g['XMLHttp' + 'Request']();",
      "import('/api/templates/cloud/publish-requests');",
      "return { dx: progress };",
    ].join("\n");
    const sampler = fakeSampler(() => ({}));
    configureEffectSampler(() => sampler);
    const { defs } = customEffectDefsFromPayload([{ meta: MANIFEST, source: hostile, sourceHash: HASH }]);
    expect(defs[0]!.animate(0.5, { px: 100 })).toEqual({});
    await Promise.resolve();
    expect(sampler.calls).toHaveLength(1);
    expect(sampler.calls[0]!.source).toBe(hostile); // handed to the sandbox, verbatim
    expect(g.__fxRan).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it("with no sampler configured a custom effect is identity, and still nothing runs", () => {
    const def = curveBackedEffect(manifestToMeta(MANIFEST), "globalThis.__fxRan = 1; return { dx: 5 };", HASH);
    expect(def.animate(0.3, {})).toEqual({});
    expect((globalThis as { __fxRan?: number }).__fxRan).toBeUndefined();
  });
});

describe("preview: identity until the curve arrives, then a repaint and the interpolated delta", () => {
  it("asks once per (effect, source, params), notifies subscribers, then interpolates", async () => {
    const sampler = fakeSampler((p, params) => ({ dx: p * Number(params.px) }));
    configureEffectSampler(() => sampler);
    const def = curveBackedEffect(manifestToMeta(MANIFEST), "src", HASH);
    const repaint = vi.fn();
    subscribeCustomEffectCurves(repaint);
    expect(def.animate(0.25, { px: 100 })).toEqual({});
    expect(def.animate(0.75, { px: 100 })).toEqual({});
    expect(sampler.calls).toHaveLength(1); // the second frame joins the first request
    sampler.release();
    await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(1));
    expect(def.animate(0.25, { px: 100 }).dx).toBeCloseTo(25, 6);
    // Different params are a different curve.
    expect(def.animate(0.25, { px: 200 })).toEqual({});
    expect(sampler.calls).toHaveLength(2);
  });

  it("a failed sample is remembered (not re-asked every frame) and draws identity", async () => {
    const failing: CurveSampler = { sample: vi.fn(() => Promise.reject(new Error('custom effect "slide" could not be sampled in the sandbox: boom'))), destroy: vi.fn() };
    configureEffectSampler(() => failing);
    const def = curveBackedEffect(manifestToMeta(MANIFEST), "src", HASH);
    def.animate(0.5, {});
    await vi.waitFor(() => expect(failing.sample).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    def.animate(0.5, {});
    def.animate(0.6, {});
    expect(failing.sample).toHaveBeenCalledTimes(1);
    expect(def.animate(0.5, {})).toEqual({});
  });
});

describe("export: every custom-effect curve is sampled before the first frame", () => {
  const custom = curveBackedEffect(manifestToMeta(MANIFEST), "src", HASH);
  const resolve = (id: string): EffectDef | undefined => (id === "slide" ? custom : BUILTIN_EFFECTS.find((e) => e.meta.id === id));

  it("waits for all of them — one per distinct resolved params — and skips built-ins", async () => {
    const sampler = fakeSampler((p) => ({ dx: p }));
    configureEffectSampler(() => sampler);
    const builtin = BUILTIN_EFFECTS.find((e) => !e.meta.textInternal && !e.meta.audioEnvelope)!.meta.id;
    let done = false;
    const gate = prepareCustomEffectCurves(
      [
        { effects: { in: { effectId: "slide" }, out: { effectId: "slide", params: { px: 100 } }, loop: { effectId: builtin } } },
        { effects: { in: { effectId: "slide", params: { px: 50 } } } },
        { effects: undefined },
        {},
      ],
      resolve,
    ).then((n) => {
      done = true;
      return n;
    });
    await Promise.resolve();
    // `{}` and `{ px: 100 }` resolve to the same params (the manifest default is 100).
    expect(sampler.calls.map((c) => c.params)).toEqual([{ px: 100 }, { px: 50 }]);
    expect(done).toBe(false);
    sampler.release();
    await expect(gate).resolves.toBe(2);
    expect(custom.animate(1, { px: 50 }).dx).toBeCloseTo(1, 9);
  });

  it("fails loudly, naming the effect, when one cannot be sampled", async () => {
    configureEffectSampler(() => ({ sample: () => Promise.reject(new Error('custom effect "slide" could not be sampled in the sandbox: animate did not finish sampling within 5 s')), destroy: vi.fn() }));
    await expect(prepareCustomEffectCurves([{ effects: { in: { effectId: "slide" } } }], resolve)).rejects.toThrow(/custom effect "slide" could not be sampled/);
  });
});
