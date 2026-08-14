import { describe, it, expect } from "vitest";
import { ComputeTrackSegmentSchema, SkipSegmentSchema, ListTrackSegmentsSchema } from "@/mcp/tools/schemas";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

describe("segment tools MCP surface", () => {
  it("compute_track_segment, skip_segment, list_track_segments are on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.compute_track_segment");
    expect(names).toContain("libi.skip_segment");
    expect(names).toContain("libi.list_track_segments");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("segment tools ARE on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_track_segment");
    expect(names).toContain("libi.skip_segment");
    expect(names).toContain("libi.list_track_segments");
  });
});

describe("segment tool schemas", () => {
  it("ComputeTrackSegmentSchema requires fileId, range, method, anchors", () => {
    expect(() => ComputeTrackSegmentSchema.parse({})).toThrow();
    const ok = ComputeTrackSegmentSchema.parse({
      fileId: "f", trackId: "trk", range: { start: 5, end: 9 },
      method: "yoloe+botsort", classes: ["person"],
      anchors: [{ fileId: "f", time: 6, bbox: [1, 2, 3, 4] }],
    });
    expect(ok.range.end).toBe(9);
    expect(ok.method).toBe("yoloe+botsort");
  });
  it("ComputeTrackSegmentSchema rejects end <= start", () => {
    expect(() => ComputeTrackSegmentSchema.parse({
      fileId: "f", range: { start: 9, end: 9 }, method: "sot",
      anchors: [{ fileId: "f", time: 6, bbox: [1, 2, 3, 4] }],
    })).toThrow();
  });
  it("SkipSegmentSchema requires a reason", () => {
    expect(() => SkipSegmentSchema.parse({ trackId: "t", range: { start: 0, end: 1 } })).toThrow();
    expect(SkipSegmentSchema.parse({ trackId: "t", range: { start: 0, end: 1 }, reason: "back to camera" }).reason).toBe("back to camera");
  });
  it("ListTrackSegmentsSchema requires trackId", () => {
    expect(ListTrackSegmentsSchema.parse({ trackId: "t" }).trackId).toBe("t");
  });
});
