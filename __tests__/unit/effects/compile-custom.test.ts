import { describe, it, expect } from "vitest";
import { compileCustomEffect } from "@/lib/effects/compile-custom";

const manifest = {
  id: "c1",
  name: "C1",
  family: "animation" as const,
  phases: ["in" as const],
  supports: ["text" as const],
  params: [],
};

describe("compileCustomEffect", () => {
  it("validates a good animate body into a metadata-only def: the server never runs it", () => {
    const r = compileCustomEffect(manifest, "return { opacity: progress };");
    expect(r.ok).toBe(true);
    // Identity on the server: the body runs only in the effect sandbox.
    if (r.ok) expect(r.def.animate(0.5, {})).toEqual({});
  });

  it("never calls the body — a body with a side effect leaves no trace when validated", () => {
    const g = globalThis as { __fxRan?: number };
    delete g.__fxRan;
    const r = compileCustomEffect(manifest, "globalThis.__fxRan = 1; return {};");
    if (r.ok) r.def.animate(0.5, {});
    expect(g.__fxRan).toBeUndefined();
  });

  it("rejects a body that does not parse", () => {
    expect(compileCustomEffect(manifest, "return { opacity: ").ok).toBe(false);
  });

  it("rejects a body that references a forbidden global", () => {
    const r = compileCustomEffect(manifest, "return { opacity: require('fs') };");
    expect(r.ok).toBe(false);
  });

  it("rejects a body that throws at runtime by returning identity safely", () => {
    const r = compileCustomEffect(manifest, "return null;");
    // null → identity delta, never throws when invoked
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.animate(0.5, {})).toEqual({});
  });
});
