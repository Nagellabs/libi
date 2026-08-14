/**
 * Pure unit test for the filter_complex builder in FfmpegOverlayBackend.
 *
 * Verifies that overlays are emitted in the input array's order (caller
 * sorts by z ascending) so export z-ordering matches the preview's
 * `overlaysActiveAt` ordering. Catches the bug where kind-grouped
 * partitioning silently re-ordered overlays at export time.
 *
 * Also verifies the scale+pad prefix that enforces composition dimensions
 * (Task 5 — Plan 4).
 */
import { describe, it, expect } from "vitest";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import type { Overlay } from "@/lib/engine/types";

const DEFAULT_COMP = { width: 1920, height: 1080 };

function mkText(id: string, z: number, content = "t"): Overlay {
  return {
    id, kind: "text", content,
    font: "24px Inter", color: "#ffffff", align: "left", opacity: 1,
    rect: { x: 0, y: 0, width: 100, height: 30 },
    startTime: 0, duration: 1, z,
  };
}

function mkImage(id: string, z: number): Overlay {
  return {
    id, kind: "image", fileId: `${id}-file`,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    startTime: 0, duration: 1, z, opacity: 1,
  };
}

describe("buildFilterChain", () => {
  it("produces a scale+pad passthrough for an empty overlays list", () => {
    const chain = buildFilterChain([], new Map(), DEFAULT_COMP);
    expect(chain).toContain("[0:v]scale=1920:1080");
    expect(chain).toContain("[base]copy[vout]");
  });

  it("emits overlays in the input array order", () => {
    // Caller sorts ascending by z. Use distinct text contents so we can
    // locate each text overlay's drawtext segment within the chain.
    const overlays = [
      mkText("bottomText", 0, "BOTTOM"),
      mkImage("midImage", 1),
      mkText("topText", 2, "TOP"),
    ];
    const assetIdx = new Map<string, number>([["midImage", 1]]);
    const chain = buildFilterChain(overlays, assetIdx, DEFAULT_COMP);

    const posBottom = chain.indexOf("BOTTOM");
    // The image now emits a scale step then an overlay step; search for
    // [ovl1]overlay which is the actual compositing step for midImage (index 1
    // in the overlays array, so label ovl1).
    const posImage = chain.indexOf("[ovl1]overlay");
    const posTop = chain.indexOf("TOP");

    expect(posBottom).toBeGreaterThan(-1);
    expect(posImage).toBeGreaterThan(-1);
    expect(posTop).toBeGreaterThan(-1);
    // Each subsequent overlay appears later in the chain than its predecessor.
    expect(posBottom).toBeLessThan(posImage);
    expect(posImage).toBeLessThan(posTop);
  });

  it("preserves text-above-image when the text has higher z", () => {
    // Reproduces the reviewer's scenario: text with z=10 should render above
    // an image with z=1. After the caller's z-sort, the input order is
    // [image, text]; the chain must emit image first, text last.
    const overlays = [mkImage("img", 1), mkText("txt", 10, "TOP")];
    const assetIdx = new Map<string, number>([["img", 1]]);
    const chain = buildFilterChain(overlays, assetIdx, DEFAULT_COMP);

    // Image is at index 0 → label ovl0
    const posImage = chain.indexOf("[ovl0]overlay");
    const posText = chain.indexOf("TOP");

    expect(posImage).toBeGreaterThan(-1);
    expect(posText).toBeGreaterThan(-1);
    expect(posImage).toBeLessThan(posText);
  });

  it("ends with [vout] as the terminal label", () => {
    const overlays = [mkText("a", 0), mkText("b", 1)];
    const chain = buildFilterChain(overlays, new Map(), DEFAULT_COMP);
    expect(chain.endsWith("[vout]")).toBe(true);
  });
});

describe("buildFilterChain — composition dimensions", () => {
  it("prepends scale+pad for vertical canvas", () => {
    const chain = buildFilterChain([], new Map(), { width: 576, height: 1024 });
    expect(chain).toContain("scale=576:1024:force_original_aspect_ratio=decrease");
    expect(chain).toContain("pad=576:1024");
    expect(chain).toContain("setsar=1[base]");
  });

  it("prepends scale+pad for horizontal canvas", () => {
    const chain = buildFilterChain([], new Map(), { width: 1920, height: 1080 });
    expect(chain).toContain("scale=1920:1080");
  });

  it("scales image overlays to their rect dimensions", () => {
    const overlays: Overlay[] = [
      {
        id: "img", kind: "image", fileId: "img-file",
        rect: { x: 100, y: 200, width: 320, height: 240 },
        startTime: 0, duration: 5, z: 0, opacity: 1,
      },
    ];
    const chain = buildFilterChain(
      overlays,
      new Map([["img", 1]]),
      { width: 1920, height: 1080 },
    );
    expect(chain).toContain("[1:v]scale=320:240:force_original_aspect_ratio=decrease[ovl0]");
    expect(chain).toContain("[base][ovl0]overlay=100:200");
  });

  it("base label flows through text overlays", () => {
    const overlays: Overlay[] = [
      {
        id: "t", kind: "text", content: "X",
        font: "24px Inter", color: "#ffffff", align: "left", opacity: 1,
        rect: { x: 0, y: 0, width: 100, height: 30 },
        startTime: 0, duration: 1, z: 0,
      },
    ];
    const chain = buildFilterChain(overlays, new Map(), { width: 1920, height: 1080 });
    // First filter takes [0:v] → [base], then text drawtext takes [base] → [vout]
    expect(chain).toMatch(/\[0:v\]scale=.+\[base\];\[base\]drawtext=.+\[vout\]/);
  });

  it("composites at the TARGET resolution (native-res overlays, no lanczos upscale)", () => {
    // comp 1920×1080 exported at 4K (3840×2160) → scale 2×. The base is scaled to
    // target dims and drawtext rasterizes at the scaled fontsize — NOT drawn at
    // 1080 then lanczos-upscaled (which blurred text). fontsize 24 → 48.
    const overlays = [mkText("t", 0, "X")];
    const chain = buildFilterChain(overlays, new Map(), {
      width: 1920,
      height: 1080,
      targetWidth: 3840,
      targetHeight: 2160,
    });
    // Base composited at target dims.
    expect(chain).toContain("[0:v]scale=3840:2160");
    // Text rasterized natively at the scaled fontsize (24 × 2).
    expect(chain).toContain("fontsize=48");
    // No upscale stage — overlays wrote straight to [vout].
    expect(chain).not.toContain("lanczos");
    expect(chain).not.toContain("vcanvas");
  });

  it("scales an image overlay's rect to the target resolution", () => {
    const chain = buildFilterChain([mkImage("i", 0)], new Map([["i", 1]]), {
      width: 1920,
      height: 1080,
      targetWidth: 3840,
      targetHeight: 2160,
    });
    // 100×100 rect at (0,0) → 200×200 at target scale.
    expect(chain).toContain("[1:v]scale=200:200:force_original_aspect_ratio=decrease[ovl0]");
  });
});
