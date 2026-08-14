import { describe, it, expect } from "vitest";
import {
  UpdateTrackedOverlaySchema,
  AddTrackedOverlaySchema,
} from "@/mcp/tools/schemas";

describe("tracked overlay size params", () => {
  it("accepts sizeMode + maxBoxScale on update", () => {
    const r = UpdateTrackedOverlaySchema.safeParse({
      pieceId: "p",
      overlayId: "o",
      sizeMode: "raw",
      maxBoxScale: 1.3,
    });
    expect(r.success).toBe(true);
  });
  it("rejects maxBoxScale < 1 and bad sizeMode", () => {
    expect(
      UpdateTrackedOverlaySchema.safeParse({
        pieceId: "p",
        overlayId: "o",
        maxBoxScale: 0.5,
      }).success,
    ).toBe(false);
    expect(
      UpdateTrackedOverlaySchema.safeParse({
        pieceId: "p",
        overlayId: "o",
        sizeMode: "weird",
      }).success,
    ).toBe(false);
  });
  it("add schema also accepts the optional fields", () => {
    const base = {
      pieceId: "p",
      trackId: "t",
      startTime: 0,
      duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      z: 0,
      opacity: 1,
      content: { kind: "emoji", char: "x" },
      fit: "tight",
      scale: 1,
      smoothing: "linear",
      sizeMode: "stabilized",
      maxBoxScale: 2,
    };
    expect(AddTrackedOverlaySchema.safeParse(base).success).toBe(true);
  });
});
