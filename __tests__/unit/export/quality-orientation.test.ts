import { describe, it, expect } from "vitest";
import { resolveExportSettings } from "@/lib/export/quality";

const base = {
  format: "mp4" as const,
  codec: "avc1.640028",
  fps: 30,
  audioBitrate: 256_000,
};

describe("export presets — landscape regression", () => {
  // These are the exact numbers shipped before orientation awareness. Any
  // change here is a regression for every existing 16:9 piece.
  it.each([
    ["1080p", 1920, 1080],
    ["1440p", 2560, 1440],
    ["4k", 3840, 2160],
  ] as const)("16:9 at %s is unchanged", (quality, w, h) => {
    const s = resolveExportSettings({
      ...base,
      quality,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect([s.width, s.height]).toEqual([w, h]);
  });
});

describe("export presets — portrait", () => {
  it("keeps 9:16 portrait instead of emitting a landscape frame", () => {
    // The defect this task fixes: the preset used to force 1920x1080,
    // silently turning a vertical piece horizontal at export.
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect([s.width, s.height]).toEqual([1080, 1920]);
  });

  it("scales the long edge from the short-edge target", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "4k",
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect([s.width, s.height]).toEqual([2160, 3840]);
  });

  it("handles 4:5 portrait", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 1080,
      sourceHeight: 1350,
    });
    expect([s.width, s.height]).toEqual([1080, 1350]);
  });
});

describe("export presets — square and ultrawide", () => {
  it("keeps 1:1 square", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 1080,
      sourceHeight: 1080,
    });
    expect([s.width, s.height]).toEqual([1080, 1080]);
  });

  it("keeps 21:9 ultrawide", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 2520,
      sourceHeight: 1080,
    });
    expect([s.width, s.height]).toEqual([2520, 1080]);
  });
});

describe("export presets — degenerate source", () => {
  // The guard exists because a corrupt manifest can carry a zero dimension.
  // Without a test, a future edit that flips the comparison would emit NaN
  // width/height, which fails deep inside ffmpeg with an opaque message
  // rather than here.
  it.each([
    ["zero height", 1080, 0],
    ["zero width", 0, 1920],
    ["negative height", 1080, -10],
  ] as const)("falls back to a square frame for %s", (_label, w, h) => {
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: w,
      sourceHeight: h,
    });
    expect(Number.isFinite(s.width)).toBe(true);
    expect(Number.isFinite(s.height)).toBe(true);
    expect([s.width, s.height]).toEqual([1080, 1080]);
  });

  it("does not emit NaN for a NaN source dimension", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: Number.NaN,
      sourceHeight: 1920,
    });
    expect(Number.isNaN(s.width)).toBe(false);
    expect(Number.isNaN(s.height)).toBe(false);
  });
});

describe("export presets — invariants preserved", () => {
  it("source quality still passes the composition dims through", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "source",
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect([s.width, s.height]).toEqual([1080, 1920]);
  });

  it("custom quality still wins over the source dims", () => {
    const s = resolveExportSettings({
      ...base,
      quality: "custom",
      sourceWidth: 1080,
      sourceHeight: 1920,
      customWidth: 720,
      customHeight: 1280,
    });
    expect([s.width, s.height]).toEqual([720, 1280]);
  });

  it("still throws when custom omits its dimensions", () => {
    expect(() =>
      resolveExportSettings({
        ...base,
        quality: "custom",
        sourceWidth: 1080,
        sourceHeight: 1920,
      }),
    ).toThrow(/custom quality requires/);
  });

  it("a near-16:9 (but not exact) piece now preserves its real aspect — deliberate behaviour change", () => {
    // Before orientation-awareness, EVERY preset forced 1920x1080 regardless
    // of source, so a 1912x1080 piece (close to but not exactly 16:9) also
    // exported at 1920x1080. Now the short-edge model preserves the piece's
    // own aspect, so it exports at 1912x1080 instead. That's correct — the
    // export should match the piece, not silently stretch it a few
    // pixels — but it IS a behaviour change for any existing near-16:9
    // piece, so pin the new value here rather than let it drift unnoticed.
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 1912,
      sourceHeight: 1080,
    });
    expect([s.width, s.height]).toEqual([1912, 1080]);
  });

  it("always emits even dimensions", () => {
    // yuv420p requires even; an odd aspect must still round cleanly.
    const s = resolveExportSettings({
      ...base,
      quality: "1080p",
      sourceWidth: 1000,
      sourceHeight: 1401,
    });
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
    expect(Math.min(s.width, s.height)).toBe(1080);
  });
});
