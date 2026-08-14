import { describe, it, expect } from "vitest";
import {
  defaultOverlayInit,
  clampOverlayPlacement,
  DEFAULT_OVERLAY_DURATION,
} from "@/lib/overlays/new-overlay-defaults";

const ctx = { startTime: 2, width: 1920, height: 1080, z: 5, totalDuration: 10 };

describe("defaultOverlayInit", () => {
  it("text → lower-third centered band with defaults", () => {
    const o = defaultOverlayInit("text", ctx);
    expect(o.kind).toBe("text");
    expect(o.startTime).toBe(2);
    expect(o.duration).toBe(DEFAULT_OVERLAY_DURATION);
    expect(o.z).toBe(5);
    if (o.kind !== "text") throw new Error("kind");
    expect(o.content).toBe("New text");
    expect(o.rect.x).toBeGreaterThan(0);
    expect(o.rect.y).toBeGreaterThan(ctx.height * 0.6);
    expect(o.rect.width).toBeGreaterThan(ctx.width * 0.3);
  });

  it("image → centered ~40% box carrying the fileId", () => {
    const o = defaultOverlayInit("image", { ...ctx, fileId: "f1" });
    if (o.kind !== "image") throw new Error("kind");
    expect(o.fileId).toBe("f1");
    expect(o.rect.width).toBeCloseTo(ctx.width * 0.4, 0);
    expect(o.rect.x).toBeCloseTo((ctx.width - o.rect.width) / 2, 0);
  });

  it("video → centered box carrying the fileId", () => {
    const o = defaultOverlayInit("video", { ...ctx, fileId: "v1" });
    if (o.kind !== "video") throw new Error("kind");
    expect(o.fileId).toBe("v1");
  });

  it("startTime floors at 0", () => {
    expect(defaultOverlayInit("text", { ...ctx, startTime: -3 }).startTime).toBe(0);
  });

  it("never starts past the timeline end — anchors to the last section", () => {
    // 5s timeline, playhead at 4.5s, 3s default duration → would end at 7.5s.
    // It must be pulled back to end at 5s, i.e. start at 2s.
    const o = defaultOverlayInit("text", { ...ctx, startTime: 4.5, totalDuration: 5 });
    expect(o.startTime).toBe(2);
    expect(o.startTime + o.duration).toBe(5); // ends exactly at the timeline end
  });

  it("caps duration to the timeline length on a very short comp", () => {
    const o = defaultOverlayInit("text", { ...ctx, startTime: 1, totalDuration: 2 });
    expect(o.startTime).toBe(0);
    expect(o.duration).toBe(2);
  });

  it("does not clamp when the timeline length is unknown (0)", () => {
    const o = defaultOverlayInit("text", { ...ctx, startTime: 7, totalDuration: 0 });
    expect(o.startTime).toBe(7);
    expect(o.duration).toBe(DEFAULT_OVERLAY_DURATION);
  });
});

describe("clampOverlayPlacement", () => {
  it("keeps a placement that already fits", () => {
    expect(clampOverlayPlacement({ desiredStart: 1, duration: 3, totalDuration: 10 })).toEqual({
      startTime: 1,
      duration: 3,
    });
  });
  it("pulls a past-the-end start back so it ends at the timeline end", () => {
    expect(clampOverlayPlacement({ desiredStart: 9, duration: 3, totalDuration: 10 })).toEqual({
      startTime: 7,
      duration: 3,
    });
  });
  it("caps duration to the whole video and starts at 0", () => {
    expect(clampOverlayPlacement({ desiredStart: 5, duration: 8, totalDuration: 4 })).toEqual({
      startTime: 0,
      duration: 4,
    });
  });
  it("floors a negative desired start at 0", () => {
    expect(clampOverlayPlacement({ desiredStart: -2, duration: 2, totalDuration: 10 })).toEqual({
      startTime: 0,
      duration: 2,
    });
  });
  it("leaves the start (floored) and duration untouched when totalDuration is 0/unknown", () => {
    expect(clampOverlayPlacement({ desiredStart: 7, duration: 3, totalDuration: 0 })).toEqual({
      startTime: 7,
      duration: 3,
    });
  });
});
