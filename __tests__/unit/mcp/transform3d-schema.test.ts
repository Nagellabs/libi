import { describe, it, expect } from "vitest";
import { updateOverlaySchema } from "@/mcp/tools/schemas";

describe("updateOverlaySchema transform3d (Spin payload)", () => {
  const base = { pieceId: "p1", overlayId: "o1" };

  it("accepts a transform3d with only position + rotation (no scale)", () => {
    const r = updateOverlaySchema.safeParse({
      ...base,
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 1.2 } },
    });
    expect(r.success).toBe(true);
  });
});
