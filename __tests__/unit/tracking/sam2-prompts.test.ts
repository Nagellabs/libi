/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { buildBoxPrompts } from "@/lib/tracking/sam2-fal-backend";

describe("buildBoxPrompts (422 hardening)", () => {
  const frame = { w: 608, h: 1080, totalFrames: 1156, fps: 30 };
  it("clamps a degenerate tiny bbox up to the API minimum", () => {
    const [p] = buildBoxPrompts([{ fileId: "f", time: 0.5, bbox: [300, 400, 4, 4] }] as any, frame);
    expect(p.x_max - p.x_min).toBeGreaterThanOrEqual(16);
    expect(p.y_max - p.y_min).toBeGreaterThanOrEqual(16);
  });
  it("clamps box + frame_index inside bounds", () => {
    const [p] = buildBoxPrompts([{ fileId: "f", time: 999, bbox: [600, 1070, 80, 80] }] as any, frame);
    expect(p.x_max).toBeLessThanOrEqual(608);
    expect(p.y_max).toBeLessThanOrEqual(1080);
    expect(p.frame_index).toBeLessThanOrEqual(1155);
    expect(p.frame_index).toBeGreaterThanOrEqual(0);
  });
});
