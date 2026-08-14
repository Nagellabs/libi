import { describe, it, expect } from "vitest";
import { addOverlaySchema, updateOverlaySchema } from "@/mcp/tools/schemas";

const rect = { x: 0, y: 0, width: 100, height: 100 };

describe("addOverlaySchema transform fields", () => {
  it("accepts optional rotation/flipH/flipV/group on a text overlay", () => {
    const parsed = addOverlaySchema.parse({
      pieceId: "p",
      kind: "text",
      startTime: 0,
      duration: 2,
      rect,
      content: "hi",
      rotation: 30,
      flipH: true,
      flipV: false,
      group: "captions",
    });
    expect(parsed.kind).toBe("text");
    expect((parsed as { rotation?: number }).rotation).toBe(30);
    expect((parsed as { group?: string }).group).toBe("captions");
  });

  it("parses fine with NO transform fields (all optional)", () => {
    const parsed = addOverlaySchema.parse({
      pieceId: "p",
      kind: "image",
      startTime: 0,
      duration: 2,
      rect,
      fileId: "f",
    });
    expect((parsed as { rotation?: number }).rotation).toBeUndefined();
  });
});

describe("updateOverlaySchema transform fields", () => {
  it("accepts rotation/flipH/flipV/group", () => {
    const parsed = updateOverlaySchema.parse({
      pieceId: "p",
      overlayId: "o",
      rotation: 45,
      flipV: true,
      group: "stickers",
    });
    expect(parsed.rotation).toBe(45);
    expect(parsed.flipV).toBe(true);
    expect(parsed.group).toBe("stickers");
  });

  it("rejects a non-numeric rotation", () => {
    const res = updateOverlaySchema.safeParse({
      pieceId: "p",
      overlayId: "o",
      rotation: "lots",
    });
    expect(res.success).toBe(false);
  });
});
