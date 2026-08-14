import { describe, it, expect } from "vitest";
import { matchToolCall, type ToolCallCandidate } from "@/lib/sessions/tool-call-matcher";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";

const TRACK = "libi:libi.compute_object_track" as McpToolId;
const OTHER = "libi:libi.list_pieces" as McpToolId;

function cand(id: string, toolId: McpToolId, args: unknown, order: number): ToolCallCandidate {
  return { toolCallId: id, toolId, args, order };
}

describe("matchToolCall", () => {
  it("same tool, different args: picks the args-matching candidate (the QA B2 case)", () => {
    const candidates = [
      cand("tc-obama", TRACK, { fileId: "52bdadb2", targetDescription: "the man" }, 0),
      cand("tc-jobs", TRACK, { fileId: "38cbfc5f", targetDescription: "the man" }, 1),
    ];
    // Job params for obama's job include fileId 52bdadb2.
    const hit = matchToolCall(candidates, {
      toolIds: [TRACK],
      toolArgs: { fileId: "52bdadb2", pieceId: "p1", fps: 30, targetDescription: "the man" },
    });
    expect(hit).toBe("tc-obama");
  });

  it("identical args: picks the OLDEST candidate", () => {
    const candidates = [
      cand("tc-old", TRACK, { fileId: "f1" }, 3),
      cand("tc-new", TRACK, { fileId: "f1" }, 7),
    ];
    expect(
      matchToolCall(candidates, { toolIds: [TRACK], toolArgs: { fileId: "f1" } }),
    ).toBe("tc-old");
  });

  it("args filter empties the list: falls back to oldest name-matching candidate", () => {
    const candidates = [cand("tc-1", TRACK, { fileId: "zzz" }, 0)];
    expect(
      matchToolCall(candidates, { toolIds: [TRACK], toolArgs: { fileId: "f-not-there" } }),
    ).toBe("tc-1");
  });

  it("no toolArgs hint: oldest name-matching candidate", () => {
    const candidates = [
      cand("tc-b", TRACK, {}, 2),
      cand("tc-a", TRACK, {}, 1),
      cand("tc-x", OTHER, {}, 0),
    ];
    expect(matchToolCall(candidates, { toolIds: [TRACK] })).toBe("tc-a");
  });

  it("no candidate with a matching toolId: null", () => {
    const candidates = [cand("tc-x", OTHER, {}, 0)];
    expect(matchToolCall(candidates, { toolIds: [TRACK] })).toBeNull();
  });

  it("args subset compares deep values (nested objects)", () => {
    const candidates = [
      cand("tc-1", TRACK, { range: { start: 0, end: 5 } }, 0),
      cand("tc-2", TRACK, { range: { start: 5, end: 9 } }, 1),
    ];
    expect(
      matchToolCall(candidates, {
        toolIds: [TRACK],
        toolArgs: { range: { start: 5, end: 9 }, fps: 30 },
      }),
    ).toBe("tc-2");
  });
});
