import { describe, it, expect } from "vitest";
import { matchToolCall, type ToolCallCandidate } from "@/lib/sessions/tool-call-matcher";
import { makeMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";

const TRACK = "libi:libi.track" as McpToolId;
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

describe("matchToolCall — a merged tool is told apart by its action / target", () => {
  const SHOW = "libi:libi.show" as McpToolId;
  const KEYFRAME = "libi:libi.keyframe" as McpToolId;

  it("a call with another target is never the match, and the name-only degrade does not bring it back", () => {
    const candidates = [cand("tc-ext", SHOW, { target: "extension", extensionId: "whisper" }, 0)];
    expect(matchToolCall(candidates, { toolIds: [SHOW], toolArgs: { target: "templates" } })).toBeNull();
    expect(matchToolCall(candidates, { toolIds: [SHOW], toolArgs: { target: "extension", extensionId: "whisper" } })).toBe("tc-ext");
  });

  it("picks the candidate of the same target among several in flight", () => {
    const candidates = [
      cand("tc-piece", SHOW, { target: "piece", pieceId: "p1" }, 0),
      cand("tc-tpl", SHOW, { target: "templates" }, 1),
    ];
    expect(matchToolCall(candidates, { toolIds: [SHOW], toolArgs: { target: "templates", templateId: "t1" } })).toBe("tc-tpl");
  });

  it("a part whose args have not streamed in yet stays a candidate", () => {
    expect(matchToolCall([cand("tc-early", SHOW, {}, 0)], { toolIds: [SHOW], toolArgs: { target: "templates" } })).toBe("tc-early");
  });

  it("keys on `action` for the tools that use it, and ignores an `action` arg on an ordinary tool", () => {
    expect(matchToolCall([cand("tc-d", KEYFRAME, { action: "delete" }, 0)], { toolIds: [KEYFRAME], toolArgs: { action: "list" } })).toBeNull();
    // an ordinary tool keeps the old behaviour (args filter empties, name-only wins)
    expect(matchToolCall([cand("tc-o", OTHER, { action: "x" }, 0)], { toolIds: [OTHER], toolArgs: { action: "y" } })).toBe("tc-o");
  });
});

describe("matchToolCall — a Codex call's args are the { server, tool, arguments } envelope", () => {
  it("still tells two actions of one merged tool apart", () => {
    const KEYFRAME = makeMcpToolId("libi", "libi.keyframe");
    const env = (action: string) => ({ server: "libi", tool: "libi.keyframe", arguments: { action, pieceId: "p" } });
    const candidates = [cand("tc-del", KEYFRAME, env("delete"), 0), cand("tc-list", KEYFRAME, env("list"), 1)];
    expect(matchToolCall(candidates, { toolIds: [KEYFRAME], toolArgs: { action: "list", pieceId: "p" } })).toBe("tc-list");
    expect(matchToolCall(candidates, { toolIds: [KEYFRAME], toolArgs: { action: "delete", pieceId: "p" } })).toBe("tc-del");
  });
});

describe("matchToolCall — libi.track: one tool id for every tracking job, told apart by `action`", () => {
  const TRACK_ROW = "libi:libi.track" as McpToolId;

  it("a segment repair's job lands on the compute_segment row, not an older compute row still in flight", () => {
    const candidates = [
      cand("tc-compute", TRACK_ROW, { action: "compute", fileId: "f1", objectKind: "face" }, 0),
      cand("tc-segment", TRACK_ROW, { action: "compute_segment", fileId: "f1", trackId: "t1" }, 1),
    ];
    // The job's hint is the MCP call's own args (tool-call-context), which carry the action.
    expect(matchToolCall(candidates, { toolIds: [TRACK_ROW], toolArgs: { action: "compute_segment", fileId: "f1", trackId: "t1", range: { start: 0, end: 2 } } })).toBe("tc-segment");
    expect(matchToolCall(candidates, { toolIds: [TRACK_ROW], toolArgs: { action: "compute", fileId: "f1", objectKind: "face" } })).toBe("tc-compute");
  });

  it("the shot fan-out's sub-job hint ({ action: compute }) only ever binds to the compute row", () => {
    const candidates = [
      cand("tc-ground", TRACK_ROW, { action: "ground_target", fileId: "f1", time: 1 }, 0),
      cand("tc-compute", TRACK_ROW, { action: "compute", fileId: "f1", objectKind: "object" }, 1),
    ];
    expect(matchToolCall(candidates, { toolIds: [TRACK_ROW], toolArgs: { action: "compute" } })).toBe("tc-compute");
    // with no compute row in flight a sub-job must not be pinned to an unrelated tracking call
    expect(matchToolCall([candidates[0]], { toolIds: [TRACK_ROW], toolArgs: { action: "compute" } })).toBeNull();
  });

  it("a non-job action (list) is never the job's row", () => {
    const candidates = [cand("tc-list", TRACK_ROW, { action: "list", fileId: "f1" }, 0)];
    expect(matchToolCall(candidates, { toolIds: [TRACK_ROW], toolArgs: { action: "ground_target", fileId: "f1", time: 1 } })).toBeNull();
  });
});
