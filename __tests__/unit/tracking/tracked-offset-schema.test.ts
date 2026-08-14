import { describe, it, expect } from "vitest";
import {
  AddTrackedOverlaySchema,
  UpdateTrackedOverlaySchema,
  updateOverlaySchema,
} from "@/mcp/tools/schemas";

const addBase = {
  pieceId: "p1",
  trackId: "trk-1",
  startTime: 0,
  duration: 5,
  rect: { x: 0, y: 0, width: 608, height: 1080 },
  z: 10,
  opacity: 1,
  content: { kind: "emoji", char: "⬇" },
  fit: "tight",
  scale: 1,
  smoothing: "linear",
};

describe("tracked follow-offset schemas", () => {
  it("add_tracked_overlay accepts a normalized offset", () => {
    const r = AddTrackedOverlaySchema.safeParse({ ...addBase, offset: { x: 0, y: -1 } });
    expect(r.success).toBe(true);
  });

  it("update_tracked_overlay accepts offset and rejects out-of-bounds values", () => {
    expect(
      UpdateTrackedOverlaySchema.safeParse({
        pieceId: "p1",
        overlayId: "o1",
        offset: { x: 0.25, y: -0.8 },
      }).success,
    ).toBe(true);
    expect(
      UpdateTrackedOverlaySchema.safeParse({
        pieceId: "p1",
        overlayId: "o1",
        offset: { x: 99, y: 0 },
      }).success,
    ).toBe(false);
  });

  it("the UI PATCH schema (updateOverlaySchema) accepts offset", () => {
    const r = updateOverlaySchema.safeParse({
      pieceId: "p1",
      overlayId: "o1",
      offset: { x: 0, y: -1 },
    });
    expect(r.success).toBe(true);
  });

  it("the UI PATCH schema (updateOverlaySchema) accepts a tracked scale and bounds it", () => {
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", scale: 1.6 }).success,
    ).toBe(true);
    // Same persistence bound as UpdateTrackedOverlaySchema: positive, ≤5.
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", scale: 0 }).success,
    ).toBe(false);
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", scale: 9 }).success,
    ).toBe(false);
  });
});
