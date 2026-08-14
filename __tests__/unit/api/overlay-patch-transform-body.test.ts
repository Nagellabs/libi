import { describe, it, expect } from "vitest";
import { updateOverlaySchema } from "@/mcp/tools/schemas";

// Mirrors the body schema the PATCH route derives:
//   app/api/pieces/[pieceId]/overlays/[overlayId]/route.ts
const UpdateOverlayBodySchema = updateOverlaySchema.omit({
  pieceId: true,
  overlayId: true,
});

describe("PATCH overlay route body schema", () => {
  it("accepts a transform-only body", () => {
    const res = UpdateOverlayBodySchema.safeParse({
      rotation: 30,
      flipH: true,
      flipV: false,
      group: "captions",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rotation).toBe(30);
      expect(res.data.group).toBe("captions");
    }
  });

  it("accepts a mixed transform + rect body", () => {
    const res = UpdateOverlayBodySchema.safeParse({
      rect: { x: 0, y: 0, width: 10, height: 10 },
      rotation: 12,
    });
    expect(res.success).toBe(true);
  });

  it("rejects a non-numeric rotation", () => {
    const res = UpdateOverlayBodySchema.safeParse({ rotation: "no" });
    expect(res.success).toBe(false);
  });

  it("rejects pieceId/overlayId in the body (omitted from the schema)", () => {
    // strict omit means these keys are silently stripped, not errors — assert
    // they don't survive into parsed data.
    const res = UpdateOverlayBodySchema.safeParse({ rotation: 1, pieceId: "x" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect((res.data as Record<string, unknown>).pieceId).toBeUndefined();
    }
  });
});
