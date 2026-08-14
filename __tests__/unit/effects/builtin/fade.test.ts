// __tests__/unit/effects/builtin/fade.test.ts
import { describe, it, expect } from "vitest";
import { fadeEffect } from "@/lib/effects/builtin/fade";
import { assertMotionSignature } from "@/lib/effects/__tests__/effect-harness";

describe("fade effect", () => {
  it("opacity ramps monotonically 0→1", () => {
    assertMotionSignature(fadeEffect, "in", { opacity: { monotonic: "up", from: 0, to: 1 } });
  });
  it("supports all visual kinds + scene, and in/out phases", () => {
    expect(fadeEffect.meta.phases).toEqual(expect.arrayContaining(["in", "out"]));
    expect(fadeEffect.meta.supports).toEqual(expect.arrayContaining(["text", "image", "video", "scene"]));
  });
  it("is registered in the builtin set", async () => {
    const { findEffect } = await import("@/lib/effects/registry");
    expect(findEffect("fade")).toBeDefined();
  });
});
