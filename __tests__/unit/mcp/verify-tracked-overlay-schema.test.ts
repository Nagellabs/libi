import { describe, it, expect } from "vitest";
import {
  VerifyTrackedOverlaySchema,
  VerifyTrackedOverlayShape,
} from "@/mcp/tools/schemas";

describe("VerifyTrackedOverlaySchema", () => {
  it("accepts a valid pre-attach request", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid post-attach request", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1" });
    expect(r.success).toBe(true);
  });

  it("rejects mixing pre-attach and post-attach", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1", content: { kind: "emoji", char: "x" },
      fit: "tight", pieceId: "p1", overlayId: "o1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty request", () => {
    expect(VerifyTrackedOverlaySchema.safeParse({}).success).toBe(false);
  });

  it("accepts focusRange + extraTimes + persist", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      pieceId: "p1", overlayId: "o1",
      focusRange: { start: 10, end: 14 }, extraTimes: [3.5], persist: [12],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a pre-attach follow offset within the persisted overlay bounds (±10)", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "head",
      offset: { x: 0, y: -1 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an offset outside ±10 (same bounds as add/update_tracked_overlay)", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "head",
      offset: { x: 0, y: -11 },
    });
    expect(r.success).toBe(false);
  });

  it("registration shape is a RAW shape (not ZodEffects) listing every field", () => {
    // A top-level .refine() (ZodEffects) has no .shape → the MCP SDK
    // publishes an EMPTY inputSchema and the agent blind-guesses arguments
    // (see the note above ComputeObjectTrackShape in mcp/tools/schemas.ts).
    // The registered artifact must be the plain field map.
    expect(Object.getPrototypeOf(VerifyTrackedOverlayShape)).toBe(Object.prototype);
    expect(Object.keys(VerifyTrackedOverlayShape).sort()).toEqual([
      "content",
      "extraTimes",
      "fileId",
      "fit",
      "focusRange",
      "maxBoxScale",
      "offset",
      "overlayId",
      "persist",
      "pieceId",
      "positionMode",
      "scale",
      "sizeMode",
      "smoothing",
      "trackId",
    ]);
  });

  it("accepts a pre-attach sizeMode spot-check (raw)", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
      sizeMode: "raw",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a pre-attach maxBoxScale spot-check", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
      maxBoxScale: 2,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown sizeMode value", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
      sizeMode: "bogus",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a pre-attach positionMode spot-check (raw)", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
      positionMode: "raw",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown positionMode value", () => {
    const r = VerifyTrackedOverlaySchema.safeParse({
      fileId: "f1", trackId: "t1",
      content: { kind: "emoji", char: "😀" }, fit: "tight",
      positionMode: "bogus",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-positive maxBoxScale", () => {
    for (const maxBoxScale of [-1, 0]) {
      const r = VerifyTrackedOverlaySchema.safeParse({
        fileId: "f1", trackId: "t1",
        content: { kind: "emoji", char: "😀" }, fit: "tight",
        maxBoxScale,
      });
      expect(r.success).toBe(false);
    }
  });
});
