import { describe, it, expect } from "vitest";
import { validateThreeFunction } from "@/lib/ai/scene-validator";

describe("validateThreeFunction", () => {
  it("accepts a well-formed build-once body", () => {
    const body = `
const label = new Text();
label.text = "HI";
scene.add(label);
return ({ progress }) => { label.position.z = helpers.interpolate(progress, [0,1], [-5,1]); };`;
    expect(validateThreeFunction(body)).toEqual({ valid: true });
  });

  it("rejects empty code", () => {
    expect(validateThreeFunction("   ").valid).toBe(false);
  });

  it("rejects forbidden patterns (import / fetch / new Function)", () => {
    expect(validateThreeFunction("import('three')").valid).toBe(false);
    expect(validateThreeFunction("fetch('/x')").valid).toBe(false);
    expect(validateThreeFunction("new Function('return 1')()").valid).toBe(false);
  });

  it("rejects a syntax error", () => {
    expect(validateThreeFunction("return ({ progress }) => {").valid).toBe(false);
  });
});
