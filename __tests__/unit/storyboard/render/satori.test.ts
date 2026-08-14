// __tests__/unit/storyboard/render/satori.test.ts
import { describe, it, expect } from "vitest";
import { renderSatoriUnit } from "@/lib/storyboard/render/satori";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("renderSatoriUnit", () => {
  it("rasterizes a satori-element-returning unit body to a PNG", async () => {
    const body = `
      return h("div",
        { style: { width: "100%", height: "100%", display: "flex",
                   background: "#123", color: "#fff", fontSize: 24, padding: 12 } },
        "Scene 1");
    `;
    const png = await renderSatoriUnit(body, { width: 120, height: 200 });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
  });
});
