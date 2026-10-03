import { describe, it, expect } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  DEFAULT_SHEET_MAX_EDGE,
  chooseGrid,
  clampRegion,
  cropAndScale,
  drawSheetJpeg,
  plainCandidates,
  regionShortSide,
} from "@/lib/render/frame-sheet";

describe("clampRegion", () => {
  it("keeps a region inside the composition as it is, in whole pixels", () => {
    expect(clampRegion({ x: 100, y: 1500, width: 880, height: 300 }, 1080, 1920)).toEqual({
      region: { x: 100, y: 1500, width: 880, height: 300 },
      clipped: false,
    });
  });

  it("cuts a region that runs off the frame and says so", () => {
    expect(clampRegion({ x: -20, y: 1800, width: 2000, height: 400 }, 1080, 1920)).toEqual({
      region: { x: 0, y: 1800, width: 1080, height: 120 },
      clipped: true,
    });
  });

  it("rounds outward so a fractional region still covers what was asked", () => {
    expect(clampRegion({ x: 10.4, y: 10.4, width: 10, height: 10 }, 100, 100)?.region).toEqual({ x: 10, y: 10, width: 11, height: 11 });
  });

  it("is null when nothing of the region is inside", () => {
    expect(clampRegion({ x: 2000, y: 0, width: 50, height: 50 }, 1080, 1920)).toBeNull();
    expect(clampRegion({ x: 0, y: 1920, width: 50, height: 50 }, 1080, 1920)).toBeNull();
  });
});

describe("regionShortSide", () => {
  it("renders at the usual size for a big region and never above the composition", () => {
    expect(regionShortSide({ x: 0, y: 0, width: 1080, height: 1920 }, 1080, 1920)).toBe(720);
    expect(regionShortSide({ x: 0, y: 0, width: 40, height: 20 }, 1080, 1920)).toBe(1080);
  });

  it("raises the render just enough for a small region to have ~900 px on its long edge", () => {
    // 1080 wide frame, a 1500 px-wide region -> 720 is plenty; a 1200 px region needs 0.75 of the short side
    expect(regionShortSide({ x: 0, y: 0, width: 1600, height: 200 }, 3840, 2160)).toBe(1215);
  });
});

describe("chooseGrid", () => {
  const portrait = 16 / 9;

  it("never draws a cell larger than the frame it came from", () => {
    const g = chooseGrid([[1, 1]], portrait, 4000, 540);
    expect(g.cellW).toBe(540);
    expect(g.width).toBe(540);
  });

  it("keeps the sheet's longest edge within maxEdge", () => {
    for (const n of [1, 2, 3, 4, 6, 9]) {
      const g = chooseGrid(plainCandidates(n), 9 / 16, DEFAULT_SHEET_MAX_EDGE, 1280);
      expect(Math.max(g.width, g.height)).toBeLessThanOrEqual(DEFAULT_SHEET_MAX_EDGE);
    }
  });

  it("lays six tall phone frames out 3 x 2, not as a row of slivers", () => {
    const g = chooseGrid(plainCandidates(6), portrait, 1024, 720);
    expect([g.cols, g.rows]).toEqual([3, 2]);
    expect(g.cellW).toBeGreaterThan(250);
  });

  it("picks pieces-across for 6 pieces x 3 times of tall frames, times-across for wide ones", () => {
    const tall = chooseGrid([[3, 6], [6, 3]], portrait, 1024, 720);
    expect([tall.cols, tall.rows]).toEqual([6, 3]);
    const wide = chooseGrid([[3, 6], [6, 3]], 9 / 16, 1024, 1280);
    expect([wide.cols, wide.rows]).toEqual([3, 6]);
  });
});

describe("plainCandidates", () => {
  it("lists the arrangements that waste less than a row", () => {
    expect(plainCandidates(5)).toEqual([[1, 5], [2, 3], [3, 2], [5, 1]]);
    expect(plainCandidates(1)).toEqual([[1, 1]]);
  });
});

describe("cropAndScale", () => {
  async function frame(w: number, h: number) {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f00";
    ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
    return loadImage(await c.encode("png"));
  }

  it("is null when neither a region nor a cap is asked for (the original file stays)", async () => {
    expect(cropAndScale(await frame(200, 100), null, null)).toBeNull();
    expect(cropAndScale(await frame(200, 100), null, 400)).toBeNull();
  });

  it("crops to the region's pixels", async () => {
    const out = cropAndScale(await frame(200, 100), { x: 100, y: 50, width: 100, height: 50 }, null)!;
    expect([out.width, out.height]).toEqual([100, 50]);
    const px = out.getContext("2d").getImageData(10, 10, 1, 1).data;
    expect([px[0], px[1], px[2]]).toEqual([255, 0, 0]); // the red quarter
  });

  it("scales down to maxEdge, keeping the shape, and never up", async () => {
    const out = cropAndScale(await frame(200, 100), null, 100)!;
    expect([out.width, out.height]).toEqual([100, 50]);
    expect(cropAndScale(await frame(200, 100), { x: 0, y: 0, width: 50, height: 50 }, 400)!.width).toBe(50);
  });
});

describe("drawSheetJpeg", () => {
  it("writes a JPEG of exactly the grid's size, with labelled cells and a note in an empty one", async () => {
    const img = createCanvas(180, 320);
    const grid = chooseGrid(plainCandidates(3), 320 / 180, 600, 180);
    const jpeg = await drawSheetJpeg(
      [
        { col: 0, row: 0, label: "P1 1s Dreams 01", src: img },
        { col: 1, row: 0, label: "P2 1s Dreams 02", src: img },
        { col: 2, row: 0, label: "P3 Dreams 03", src: null, empty: "past the end" },
      ],
      grid,
    );
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    const out = await loadImage(jpeg);
    expect([out.width, out.height]).toEqual([grid.width, grid.height]);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(600);
  });
});
