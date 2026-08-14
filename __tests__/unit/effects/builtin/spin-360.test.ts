import { describe, it, expect } from "vitest";
import { spin360Effect } from "@/lib/effects/builtin/spin-360";
describe("spin-360 effect", () => {
  it("rotates a full turn across the period", () => {
    expect(spin360Effect.animate(0, { direction: "cw" }).rotateDeg).toBeCloseTo(0, 5);
    expect(spin360Effect.animate(1, { direction: "cw" }).rotateDeg).toBeCloseTo(360, 5);
  });
});
