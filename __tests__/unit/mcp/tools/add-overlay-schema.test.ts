import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { addOverlaySchema } from "@/mcp/tools/schemas";

/**
 * Regression guard for the MCP schema-serialization bug: `add_overlay` was a
 * z.discriminatedUnion (ZodUnion, no `.shape`), so the MCP SDK advertised its
 * input as empty `{properties:{}}` and the agent couldn't pass typed
 * numeric/object args. Flattening to a plain z.object restores `.shape`.
 */
const EXPECTED_KEYS = [
  "pieceId",
  "kind",
  "startTime",
  "duration",
  "rect",
  "z",
  "opacity",
  "effects",
  "content",
  "fileId",
];

describe("add_overlay schema serialization", () => {
  it("exposes its fields via .shape (the property the MCP SDK reads)", () => {
    const shape = (addOverlaySchema as unknown as { shape: Record<string, unknown> })
      .shape;
    expect(shape).toBeDefined();
    const shapeKeys = Object.keys(shape);
    for (const k of EXPECTED_KEYS) {
      expect(shapeKeys, `missing shape key ${k}`).toContain(k);
    }
  });

  it("serializes to a non-empty JSON-Schema object (regression: union → empty properties)", () => {
    const js = zodToJsonSchema(addOverlaySchema as never) as {
      properties?: Record<string, unknown>;
    };
    expect(js.properties).toBeDefined();
    const keys = Object.keys(js.properties!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of EXPECTED_KEYS) {
      expect(keys, `missing property ${k}`).toContain(k);
    }
  });
});
