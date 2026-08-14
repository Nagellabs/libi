import { describe, it, expect } from "vitest";
import { UpdateTrackResultSchema } from "@/mcp/tools/schemas";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames, TRACKING_TOOL_NAMES } from "@/__tests__/helpers/mcp-tools";

const baseSample = { t: 0, x: 10, y: 20, w: 30, h: 40, visible: true };

const validParams = {
  fileId: "file-abc",
  method: "sam2-local",
  framerate: 30,
  samples: [baseSample],
};

describe("update_track_result MCP surface", () => {
  it("libi.update_track_result is registered on the libi-tracking MCP", () => {
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.update_track_result");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("libi.update_track_result IS registered on the core libi MCP (always-on)", () => {
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.update_track_result");
  });
});

describe("UpdateTrackResultSchema", () => {
  it("accepts well-formed params without trackId (fresh ID path)", () => {
    const result = UpdateTrackResultSchema.parse(validParams);
    expect(result.fileId).toBe("file-abc");
    expect(result.trackId).toBeUndefined();
    expect(result.samples).toHaveLength(1);
    // confidence defaults to 1 when omitted
    expect(result.samples[0].confidence).toBe(1);
  });

  it("accepts well-formed params with a pre-existing trackId", () => {
    const result = UpdateTrackResultSchema.parse({ ...validParams, trackId: "trk-existing" });
    expect(result.trackId).toBe("trk-existing");
  });

  it("accepts a free-form method string (not constrained to known values)", () => {
    const result = UpdateTrackResultSchema.parse({ ...validParams, method: "external-mcp:my-custom-tracker-v2" });
    expect(result.method).toBe("external-mcp:my-custom-tracker-v2");
  });

  it("accepts optional label and subjectId fields", () => {
    const result = UpdateTrackResultSchema.parse({ ...validParams, label: "my-label", subjectId: "char-123" });
    expect(result.label).toBe("my-label");
    expect(result.subjectId).toBe("char-123");
  });

  it("accepts optional anchors array", () => {
    const result = UpdateTrackResultSchema.parse({
      ...validParams,
      anchors: [{ fileId: "file-abc", time: 0, bbox: [10, 10, 50, 50] }],
    });
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors?.[0].bbox).toEqual([10, 10, 50, 50]);
  });

  it("rejects when samples array is empty (.min(1))", () => {
    expect(() => UpdateTrackResultSchema.parse({ ...validParams, samples: [] })).toThrow();
  });

  it("rejects when fileId is missing", () => {
    const { fileId: _, ...rest } = validParams;
    expect(() => UpdateTrackResultSchema.parse(rest)).toThrow();
  });

  it("rejects when framerate is missing", () => {
    const { framerate: _, ...rest } = validParams;
    expect(() => UpdateTrackResultSchema.parse(rest)).toThrow();
  });

  it("rejects when method is missing", () => {
    const { method: _, ...rest } = validParams;
    expect(() => UpdateTrackResultSchema.parse(rest)).toThrow();
  });

  it("rejects when framerate is zero or negative", () => {
    expect(() => UpdateTrackResultSchema.parse({ ...validParams, framerate: 0 })).toThrow();
    expect(() => UpdateTrackResultSchema.parse({ ...validParams, framerate: -1 })).toThrow();
  });

  it("rejects when method is an empty string", () => {
    expect(() => UpdateTrackResultSchema.parse({ ...validParams, method: "" })).toThrow();
  });

  it("rejects sample with confidence out of range", () => {
    expect(() => UpdateTrackResultSchema.parse({
      ...validParams,
      samples: [{ ...baseSample, confidence: 1.5 }],
    })).toThrow();
    expect(() => UpdateTrackResultSchema.parse({
      ...validParams,
      samples: [{ ...baseSample, confidence: -0.1 }],
    })).toThrow();
  });
});
