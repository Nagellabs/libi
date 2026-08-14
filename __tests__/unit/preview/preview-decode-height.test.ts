import { describe, it, expect } from "vitest";
import {
  previewMaxHeight,
  resolveDecodeHeight,
  bucketDecodeHeight,
  PREVIEW_MAX_HEIGHT_AUTO,
  PREVIEW_MAX_HEIGHT_LOW,
} from "@/lib/preview/tuning";

describe("previewMaxHeight", () => {
  it("auto → 1080 cap", () => {
    expect(previewMaxHeight("auto")).toBe(PREVIEW_MAX_HEIGHT_AUTO);
    expect(previewMaxHeight("auto")).toBe(1080);
  });
  it("720p → 720 cap", () => {
    expect(previewMaxHeight("720p")).toBe(PREVIEW_MAX_HEIGHT_LOW);
    expect(previewMaxHeight("720p")).toBe(720);
  });
});

describe("resolveDecodeHeight (resolution-aware, never upscale)", () => {
  it("decodes at native height when below the cap", () => {
    expect(resolveDecodeHeight(720, 1080)).toBe(720); // 720p source, auto cap
    expect(resolveDecodeHeight(480, 1080)).toBe(480);
  });
  it("caps a taller source at the max", () => {
    expect(resolveDecodeHeight(2160, 1080)).toBe(1080); // 4K → 1080 cap (auto)
    expect(resolveDecodeHeight(1080, 720)).toBe(720); // 1080p source, low cap
  });
  it("decodes a 1080p source at 1080 under the auto cap (the headline fix)", () => {
    expect(resolveDecodeHeight(1080, 1080)).toBe(1080);
  });
  it("falls back to the cap when the source height is unknown", () => {
    expect(resolveDecodeHeight(0, 1080)).toBe(1080);
    expect(resolveDecodeHeight(null, 720)).toBe(720);
    expect(resolveDecodeHeight(undefined, 1080)).toBe(1080);
  });
});

describe("bucketDecodeHeight (decode by on-screen rect size, Phase 2)", () => {
  it("snaps a small PIP rect UP to the nearest bucket (quadratic decode win)", () => {
    expect(bucketDecodeHeight(180, 1080)).toBe(360); // tiny PIP → 360 bucket
    expect(bucketDecodeHeight(300, 1080)).toBe(360);
    expect(bucketDecodeHeight(360, 1080)).toBe(360); // exact
    expect(bucketDecodeHeight(400, 1080)).toBe(540);
  });
  it("a full-frame rect lands in the top bucket ⇒ unchanged from the cap", () => {
    expect(bucketDecodeHeight(1080, 1080)).toBe(1080);
    expect(bucketDecodeHeight(900, 1080)).toBe(1080); // 720<900≤1080 → 1080
  });
  it("never exceeds the preview cap (720p quality clamps every bucket)", () => {
    expect(bucketDecodeHeight(1080, 720)).toBe(720);
    expect(bucketDecodeHeight(700, 720)).toBe(720); // 720 bucket, capped at 720
    expect(bucketDecodeHeight(300, 720)).toBe(360); // small PIP still small under low cap
  });
  it("unknown/zero rect height falls back to the full cap", () => {
    expect(bucketDecodeHeight(0, 1080)).toBe(1080);
    expect(bucketDecodeHeight(-5, 720)).toBe(720);
  });
});
