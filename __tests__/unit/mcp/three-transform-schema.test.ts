import { describe, it, expect } from "vitest";
import { addOverlaySchema, updateOverlaySchema } from "@/mcp/tools/schemas";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };
const threeBase = {
  pieceId: "p1",
  kind: "three" as const,
  startTime: 0,
  duration: 2,
  rect: baseRect,
  z: 0,
  opacity: 1,
};

/** An identity-ish transform exercising position + rotation. Transform3D no
 *  longer carries scale (the window-model refactor removed three's scale). */
const validTransform = {
  position: { x: 1.5, y: -2, z: 0 },
  rotation: { x: 0, y: 1.5, z: -0.25 },
};

describe("three overlay transform3d schema (SP7 Milestone 3)", () => {
  it("accepts a valid transform3d on add_overlay (kind three)", () => {
    const parsed = addOverlaySchema.safeParse({ ...threeBase, transform3d: validTransform });
    expect(parsed.success).toBe(true);
  });

  it("accepts a valid transform3d on update_overlay", () => {
    const parsed = updateOverlaySchema.safeParse({
      pieceId: "p1",
      overlayId: "o1",
      transform3d: validTransform,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-number axis", () => {
    const bad = { ...validTransform, position: { x: "nope", y: 0, z: 0 } };
    expect(addOverlaySchema.safeParse({ ...threeBase, transform3d: bad }).success).toBe(false);
    expect(
      updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", transform3d: bad }).success,
    ).toBe(false);
  });

  it("rejects out-of-range position (−10001 < −10000) and rotation (101 > 100)", () => {
    const badPos = { ...validTransform, position: { x: -10001, y: 0, z: 0 } };
    const badRot = { ...validTransform, rotation: { x: 0, y: 0, z: 101 } };
    expect(addOverlaySchema.safeParse({ ...threeBase, transform3d: badPos }).success).toBe(false);
    expect(addOverlaySchema.safeParse({ ...threeBase, transform3d: badRot }).success).toBe(false);
  });
});
