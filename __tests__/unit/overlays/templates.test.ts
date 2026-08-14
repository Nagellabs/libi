import { describe, it, expect } from "vitest";
import { starterBody } from "@/lib/overlays/templates";
import { validateDrawFunction, validateThreeFunction } from "@/lib/ai/scene-validator";

describe("overlay starter bodies", () => {
  it("code stub passes the draw validator", () => {
    const body = starterBody("code");
    expect(body.length).toBeGreaterThan(0);
    expect(validateDrawFunction(body).valid).toBe(true);
  });
  it("three stub passes the three validator", () => {
    const body = starterBody("three");
    expect(validateThreeFunction(body).valid).toBe(true);
  });
  it("tracked-code stub passes the draw validator", () => {
    expect(validateDrawFunction(starterBody("tracked-code")).valid).toBe(true);
  });
});
