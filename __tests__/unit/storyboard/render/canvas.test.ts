import { describe, it, expect } from "vitest";
import { renderCanvasUnit } from "@/lib/storyboard/render/canvas";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("renderCanvasUnit", () => {
  it("rasterizes a canvas-drawing unit body to a PNG", async () => {
    const body = `
      const { ctx, width, height } = context;
      ctx.fillStyle = "#234"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff"; ctx.fillRect(10, 10, 40, 40);
    `;
    const png = await renderCanvasUnit(body, { width: 120, height: 200 });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
  });

  it("can use an injected DRAW_HELPERS helper (interpolate)", async () => {
    const body = `
      const { ctx, width } = context;
      const x = interpolate(0.5, [0, 1], [0, width]);
      ctx.fillRect(x, 0, 4, 4);
    `;
    const png = await renderCanvasUnit(body, { width: 100, height: 100 });
    expect(isPng(png)).toBe(true);
  });

  it("injects a rough instance the body can draw with", async () => {
    const body = `
      const { ctx, rough, width, height } = context;
      ctx.fillStyle = "#f3f1ec"; ctx.fillRect(0, 0, width, height);
      rough.rectangle(20, 20, 120, 80, { fill: "#cdc9c0", fillStyle: "hachure" });
      rough.circle(150, 40, 40, { stroke: "#1a1a1a" });
    `;
    const png = await renderCanvasUnit(body, { width: 200, height: 140 });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
  });

  it("injects INK and GRAYS palette constants", async () => {
    const body = `
      const { ctx, rough, width, height, INK, GRAYS } = context;
      ctx.fillStyle = GRAYS[0]; ctx.fillRect(0, 0, width, height);
      rough.line(0, height / 2, width, height / 2, { stroke: INK });
    `;
    const png = await renderCanvasUnit(body, { width: 120, height: 80 });
    expect(isPng(png)).toBe(true);
  });

  it("renders rough output deterministically (seeded)", async () => {
    const body = `
      const { ctx, rough, width, height } = context;
      ctx.fillStyle = "#f3f1ec"; ctx.fillRect(0, 0, width, height);
      rough.rectangle(10, 10, 80, 50, { fill: "#9b968c", fillStyle: "hachure", roughness: 1.8 });
      rough.circle(150, 60, 40, { stroke: "#1a1a1a", roughness: 2 });
    `;
    const a = await renderCanvasUnit(body, { width: 200, height: 120 });
    const b = await renderCanvasUnit(body, { width: 200, height: 120 });
    expect(a.equals(b)).toBe(true);
  });
});
