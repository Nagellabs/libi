import { describe, it, expect } from "vitest";
import { frameDroppedOverlaysInResult } from "@/mcp/tools/job-tools";
import { DIAGNOSTIC_MESSAGE_SOURCE, LIBI_MESSAGE_SOURCE } from "@/mcp/tools/body-message";

describe("libi.job({ action: 'status' }) — an export result's droppedOverlays are framed as body text (Task 10 f)", () => {
  it("marks each message and leaves the rest of the result alone", () => {
    const out = frameDroppedOverlaysInResult(JSON.stringify({ filePath: "/x.mp4", droppedOverlays: [{ id: "o", message: "render: boom" }] }));
    expect(JSON.parse(out!)).toEqual({
      filePath: "/x.mp4",
      droppedOverlays: [{ id: "o", message: "render: boom", messageSource: DIAGNOSTIC_MESSAGE_SOURCE }],
    });
  });
  it("frames a dropped VIDEO as libi's own text, keeps its fileId and drops its name (N3)", () => {
    const out = frameDroppedOverlaysInResult(
      JSON.stringify({ droppedOverlays: [{ id: "v", message: "its video could not be loaded", kind: "video", fileId: "f1", name: "clip.mp4" }] }),
    );
    expect(JSON.parse(out!).droppedOverlays).toEqual([
      { id: "v", message: "its video could not be loaded", kind: "video", fileId: "f1", messageSource: LIBI_MESSAGE_SOURCE },
    ]);
  });
  it("passes through results without droppedOverlays, null, and anything unparseable", () => {
    expect(frameDroppedOverlaysInResult(null)).toBeNull();
    expect(frameDroppedOverlaysInResult('{"a":1}')).toBe('{"a":1}');
    expect(frameDroppedOverlaysInResult("{nope")).toBe("{nope");
  });
});
