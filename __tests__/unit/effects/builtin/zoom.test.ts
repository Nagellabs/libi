// __tests__/unit/effects/builtin/zoom.test.ts
import { describe, it, expect } from "vitest";
import { zoomEffect } from "@/lib/effects/builtin/zoom";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("zoom effect", () => {
  it("scale grows monotonically from <1 to 1 (zoom in)", () => {
    assertMotionSignature(zoomEffect, "in", { scale: { from: 0.7, to: 1, monotonic: "up" } }, { from: 0.7 });
  });
  it("supports base scenes", () => {
    expect(zoomEffect.meta.supports).toContain("scene");
  });
  it("identity at p=1", () => {
    expect(zoomEffect.animate(1, { from: 0.7 })).toEqual({});
  });
});
