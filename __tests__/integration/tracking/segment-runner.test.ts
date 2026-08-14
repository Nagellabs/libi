import { describe, it, expect } from "vitest";
import { trackingRunner } from "@/lib/jobs/runners/tracking";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

describe("compute_track_segment MCP surface (segment-runner file)", () => {
  it("libi.compute_track_segment is registered on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.compute_track_segment");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("libi.compute_track_segment IS registered on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_track_segment");
  });
});

describe("trackingRunner segment-scoped", () => {
  it("accepts range+method+classes and defaults method to legacy", () => {
    const engine = trackingRunner.paramsSchema.parse({
      fileId: "f", pieceId: "p", fileUrl: "http://x/v.mp4", fps: 5,
      objectKind: "object", method: "yoloe+botsort",
      range: { start: 0, end: 1 }, classes: ["person"],
      anchors: [{ fileId: "f", time: 0, bbox: [1, 2, 3, 4] }],
    });
    expect(engine.range).toEqual({ start: 0, end: 1 });
    expect(engine.method).toBe("yoloe+botsort");

    const legacy = trackingRunner.paramsSchema.parse({
      fileId: "f", pieceId: "p", fileUrl: "http://x/v.mp4", fps: 5,
      objectKind: "object",
      anchors: [{ fileId: "f", time: 0, bbox: [1, 2, 3, 4] }],
    });
    expect(legacy.method).toBe("mediapipe-object"); // default keeps legacy behavior
    expect(legacy.range).toBeUndefined();
  });
});
