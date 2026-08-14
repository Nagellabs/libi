// __tests__/unit/tools/tracking-schemas.test.ts
import { describe, it, expect } from "vitest";
import {
  ComputeObjectTrackSchema,
  AddTrackedOverlaySchema,
  UpdateTrackedOverlaySchema,
  DeleteTrackSchema,
  ListTracksSchema,
} from "@/mcp/tools/schemas";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

describe("tracking tool schemas — MCP surface", () => {
  it("all 12 tracking tools are registered on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("all 12 tracking tools appear on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });
});

describe("tracking tool schemas", () => {
  it("ComputeObjectTrackSchema requires fileId + objectKind + anchors", () => {
    expect(() => ComputeObjectTrackSchema.parse({})).toThrow();
    // Without anchors[], parse must fail post-Task 8.
    expect(() =>
      ComputeObjectTrackSchema.parse({ fileId: "f", objectKind: "face" }),
    ).toThrow();
    const p = ComputeObjectTrackSchema.parse({
      fileId: "f",
      objectKind: "face",
      anchors: [{ fileId: "f", time: 0, bbox: [0, 0, 10, 10] }],
    });
    expect(p.objectKind).toBe("face");
    expect(p.anchors).toHaveLength(1);
  });
  it("AddTrackedOverlaySchema validates content union", () => {
    const base = {
      pieceId: "p", trackId: "t", startTime: 0, duration: 5,
      z: 10, opacity: 1, fit: "tight", scale: 1, smoothing: "linear",
      rect: { x: 0, y: 0, width: 100, height: 100 },
    };
    expect(AddTrackedOverlaySchema.parse({ ...base, content: { kind: "emoji", char: "😀" } }).content.kind).toBe("emoji");
    expect(AddTrackedOverlaySchema.parse({ ...base, content: { kind: "text", content: "hi", font: "48px Inter", color: "#fff", align: "center" } }).content.kind).toBe("text");
    expect(AddTrackedOverlaySchema.parse({ ...base, content: { kind: "image", fileId: "f1" } }).content.kind).toBe("image");
    expect(AddTrackedOverlaySchema.parse({ ...base, content: { kind: "code", drawFunction: "ctx.fillRect(0,0,10,10)" } }).content.kind).toBe("code");
    expect(AddTrackedOverlaySchema.parse({ ...base, content: { kind: "effect", op: "blur" } }).content.kind).toBe("effect");
    expect(() => AddTrackedOverlaySchema.parse({ ...base, content: { kind: "unknown" } as never })).toThrow();
  });
  it("scale must be > 0", () => {
    expect(() => AddTrackedOverlaySchema.parse({
      pieceId: "p", trackId: "t", startTime: 0, duration: 5,
      z: 10, opacity: 1, fit: "tight", scale: 0, smoothing: "linear",
      rect: { x: 0, y: 0, width: 100, height: 100 },
      content: { kind: "emoji", char: "😀" },
    })).toThrow();
  });
});
