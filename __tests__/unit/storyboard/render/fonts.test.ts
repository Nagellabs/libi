import { describe, it, expect } from "vitest";
import { loadDefaultFont } from "@/lib/storyboard/render/fonts";

describe("storyboard font loader", () => {
  it("loads a non-empty TTF buffer", () => {
    const buf = loadDefaultFont();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(50000);
  });
  it("returns the same cached buffer on repeat calls", () => {
    expect(loadDefaultFont()).toBe(loadDefaultFont());
  });
});
