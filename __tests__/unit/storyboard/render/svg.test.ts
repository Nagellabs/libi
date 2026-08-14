import { describe, it, expect } from "vitest";
import { renderSvgUnit } from "@/lib/storyboard/render/svg";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("renderSvgUnit", () => {
  it("rasterizes an SVG-returning unit body to a PNG", () => {
    const body = `return '<svg xmlns="http://www.w3.org/2000/svg" width="' + context.width + '" height="' + context.height + '"><rect width="100%" height="100%" fill="#234"/></svg>';`;
    const png = renderSvgUnit(body, { width: 120, height: 200 });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
  });

  it("throws if the body does not return a string", () => {
    expect(() => renderSvgUnit(`return 42;`, { width: 10, height: 10 })).toThrow();
  });
});
