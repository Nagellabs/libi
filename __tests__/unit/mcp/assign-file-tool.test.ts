import { describe, it, expect } from "vitest";
import { assignFileSchema } from "@/mcp/tools/schemas";

describe("assignFileSchema", () => {
  it("accepts a fileId with a target pieceId", () => {
    const parsed = assignFileSchema.parse({ fileId: "f1", pieceId: "p1" });
    expect(parsed).toEqual({ fileId: "f1", pieceId: "p1" });
  });

  it("accepts null pieceId, which means 'make it unassigned'", () => {
    // The un-assign direction is half the tool's purpose: it is how a file is
    // taken back OUT of a piece, and how the UI's drag-to-root works.
    expect(assignFileSchema.parse({ fileId: "f1", pieceId: null })).toEqual({
      fileId: "f1",
      pieceId: null,
    });
  });

  it("rejects a missing fileId", () => {
    expect(() => assignFileSchema.parse({ pieceId: "p1" })).toThrow();
  });
});

describe("zod version", () => {
  it("is built on zod/v3", async () => {
    // Not pedantry: under zod v4 the MCP SDK's JSON-schema conversion fails
    // SILENTLY and every tool vanishes from tools/list. A v3 schema exposes
    // `_def.typeName`; v4 does not.
    const mod = await import("@/mcp/tools/schemas");
    expect((mod.assignFileSchema as unknown as { _def: { typeName?: string } })._def.typeName)
      .toBe("ZodObject");
  });
});
