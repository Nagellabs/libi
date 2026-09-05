import { describe, it, expect } from "vitest";
import { sketchUrl } from "@/components/storyboard/card/sketches-row";

describe("sketchUrl", () => {
  const base = "/api/pieces/p1/storyboard/cards/c1/sketches/s1";

  it("appends the revision so a regenerated PNG is re-requested", () => {
    expect(sketchUrl("p1", "c1", "s1", "abc123def456")).toBe(`${base}?v=abc123def456`);
  });

  it("changes when the revision changes", () => {
    expect(sketchUrl("p1", "c1", "s1", "rev1")).not.toBe(sketchUrl("p1", "c1", "s1", "rev2"));
  });

  it("differs for different slots on the same card, given the same revision", () => {
    expect(sketchUrl("p1", "c1", "s1", "rev1")).not.toBe(sketchUrl("p1", "c1", "s2", "rev1"));
  });

  it("omits the param when no revision is known", () => {
    expect(sketchUrl("p1", "c1", "s1", undefined)).toBe(base);
    expect(sketchUrl("p1", "c1", "s1", "")).toBe(base);
  });
});
