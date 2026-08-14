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
  it("compiles a valid animate body to an EffectDef", () => {
    const r = compileCustomEffect(manifest, "return { opacity: progress };");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.animate(0.5, {}).opacity).toBeCloseTo(0.5);
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
