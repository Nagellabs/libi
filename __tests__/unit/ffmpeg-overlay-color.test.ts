import { describe, it, expect } from "vitest";
import { cssColorToFfmpeg } from "@/lib/export/backends/ffmpeg-overlay";

describe("cssColorToFfmpeg", () => {
  it("passes through #RRGGBB", () => {
    expect(cssColorToFfmpeg("#ff00aa")).toBe("#ff00aa");
  });

  it("passes through #RRGGBBAA", () => {
    expect(cssColorToFfmpeg("#ff00aa80")).toBe("#ff00aa80");
  });

  it("expands #RGB shorthand to #RRGGBB", () => {
    expect(cssColorToFfmpeg("#fa0")).toBe("#ffaa00");
  });

  it("expands #RGBA shorthand to #RRGGBBAA", () => {
    expect(cssColorToFfmpeg("#fa08")).toBe("#ffaa0088");
  });

  it("converts rgb(r, g, b) to #RRGGBB", () => {
    expect(cssColorToFfmpeg("rgb(255, 170, 0)")).toBe("#ffaa00");
  });

  it("converts rgba(r, g, b, a) to #RRGGBBAA", () => {
    expect(cssColorToFfmpeg("rgba(255, 0, 0, 0.5)")).toBe("#ff000080");
  });

  it("clamps out-of-range rgb components (>255)", () => {
    expect(cssColorToFfmpeg("rgb(300, 500, 128)")).toBe("#ffff80");
  });

  it("lowercases named CSS colors", () => {
    expect(cssColorToFfmpeg("White")).toBe("white");
  });

  it("falls back to #ffffff for unsupported formats (hsl, lab, garbage)", () => {
    expect(cssColorToFfmpeg("hsl(180, 50%, 50%)")).toBe("#ffffff");
    expect(cssColorToFfmpeg("lab(50% 40 59.5)")).toBe("#ffffff");
    expect(cssColorToFfmpeg("not a color")).toBe("#ffffff");
    expect(cssColorToFfmpeg("")).toBe("#ffffff");
  });
});
