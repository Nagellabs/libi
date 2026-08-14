import { describe, it, expect } from "vitest";
import rough from "roughjs";
import { createCanvas } from "@napi-rs/canvas";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("roughjs ↔ @napi-rs/canvas", () => {
  it("draws sketchy shapes onto a node canvas and encodes a PNG", async () => {
    const canvas = createCanvas(200, 140);
    const rc = rough.canvas(canvas as unknown as HTMLCanvasElement, {
      options: { seed: 7 },
    });
    rc.rectangle(20, 20, 120, 80, { fill: "#cdc9c0", fillStyle: "hachure" });
    rc.circle(150, 40, 40, { stroke: "#1a1a1a" });
    const png = Buffer.from(await canvas.encode("png"));
    expect(isPng(png)).toBe(true);
  });
});
