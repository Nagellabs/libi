import { describe, it, expect } from "vitest";
import { addOverlaySchema, updateOverlaySchema, getOverlaysSchema } from "@/mcp/tools/schemas";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };
const common = { pieceId: "p1", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1 };

describe("consolidated overlay schemas", () => {
  it("accepts a three overlay with optional body", () => {
    expect(addOverlaySchema.safeParse({ ...common, kind: "three", cameraPreset: "ground" }).success).toBe(true);
    expect(addOverlaySchema.safeParse({ ...common, kind: "three", body: "scene.add(x)" }).success).toBe(true);
  });
  it("accepts a text overlay", () => {
    expect(addOverlaySchema.safeParse({ ...common, kind: "text", content: "hi", font: "20px sans", color: "#fff", align: "center" }).success).toBe(true);
  });
  it("accepts image/video with fileId (per-kind required-field check is in the handler)", () => {
    // The schema is a flat z.object (so the MCP SDK can read `.shape`); fileId is
    // therefore schema-optional. The text→content / image|video→fileId requirement
    // is enforced in the addOverlay HANDLER, not the schema — see
    // __tests__/integration/overlay-tools.test.ts. Parsing an image with no
    // fileId succeeds at the schema level by design.
    expect(addOverlaySchema.safeParse({ ...common, kind: "image" }).success).toBe(true);
    expect(addOverlaySchema.safeParse({ ...common, kind: "image", fileId: "f1" }).success).toBe(true);
  });
  it("update accepts structured fields, rejects code body", () => {
    expect(updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", rect: baseRect, z: 3 }).success).toBe(true);
    expect(updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", content: "new text" }).success).toBe(true);
    // body/drawFunction/sceneFunction are NOT accepted update fields:
    const parsed = updateOverlaySchema.safeParse({ pieceId: "p1", overlayId: "o1", sceneFunction: "x" });
    if (parsed.success) expect((parsed.data as Record<string, unknown>).sceneFunction).toBeUndefined();
  });
  it("get_overlays needs a pieceId", () => {
    expect(getOverlaysSchema.safeParse({ pieceId: "p1" }).success).toBe(true);
    expect(getOverlaysSchema.safeParse({}).success).toBe(false);
  });
});
