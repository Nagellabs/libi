/**
 * Tool progress was dropped for non-job tools on BOTH agents:
 *  - codex-acp 1.10.0 forwards an MCP progress message as a `_meta`-only update
 *    (`dist/index.js:24859-24869`): { sessionUpdate: "tool_call_update", toolCallId,
 *    _meta: { mcp_output_delta: { data } } }. libi read text only from `content`, and
 *    treated that status-less, content-less update as a refinement that flipped the
 *    OLDEST pending call.
 *  - claude-agent-acp 0.75.1 heartbeats carry `_meta.claudeCode.toolResponse.elapsedTimeSeconds`
 *    and no text at all (`dist/acp-agent.js:4211-4250`).
 *  - libi's own non-job progress also arrives on the `job_progress` side channel, with
 *    `jobId: ""` and a verbatim `message`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { attachToolCallId, kindMap } = vi.hoisted(() => ({
  attachToolCallId: vi.fn(),
  kindMap: new Map<string, string[]>(),
}));
vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    getJobIdForToolCallId: () => null,
    attachToolCallId: (...a: unknown[]) => attachToolCallId(...a),
    on: () => {},
    off: () => {},
  }),
}));
vi.mock("@/lib/db/settings", () => ({ getNotificationsSetting: () => ({ backgroundJobComplete: false }) }));
vi.mock("@/lib/jobs/runners/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runners/registry")>()),
  getJobKindToToolIdsMap: () => kindMap,
}));

import { SessionEventHandler, extractMcpOutputDelta, formatElapsedProgress } from "@/lib/agents/session-event-handler";
import { jobProgressEmitter } from "@/lib/jobs/progress-emitter";
import type { AgentEvent } from "@/lib/agents/types";
import type { SessionEntry } from "@/lib/sessions/types";

function makeSession(agentId: "codex" | "claude-code"): SessionEntry {
  return {
    sessionId: "s1", agentId, title: null, updatedAt: null, active: true, lastUsed: Date.now(),
    messageCache: [], currentAgentMessage: null, currentUserMessage: null, listeners: new Set(),
    pendingApprovals: new Map(), configOptions: [], latestUsage: null, availableCommands: [],
  };
}

describe("tool progress text for non-job tools", () => {
  let session: SessionEntry;
  let events: AgentEvent[];
  let handler: SessionEventHandler;

  function setup(agentId: "codex" | "claude-code") {
    session = makeSession(agentId);
    events = [];
    let n = 0;
    handler = new SessionEventHandler({ next: () => n++ }, (_sid, ev) => events.push(ev), () => session);
  }
  const update = (u: Record<string, unknown>) =>
    handler.handleSessionUpdate("s1", { sessionId: "s1", update: u } as never);
  const announceCodex = (toolCallId: string) =>
    update({
      sessionUpdate: "tool_call", toolCallId, title: "mcp.libi-app.libi.sleep", kind: "execute",
      rawInput: { server: "libi-app", tool: "libi.sleep", arguments: { seconds: 20 } },
      _meta: { is_mcp_tool_call: true },
    });
  const announceClaude = (toolCallId: string, title = "mcp__fal-ai__generate_video") =>
    update({ sessionUpdate: "tool_call", toolCallId, title, rawInput: { seconds: 20 } });
  function part(toolCallId: string) {
    for (const m of session.messageCache) {
      const p = m.parts.find((x) => x.type === "tool-call" && x.toolCallId === toolCallId);
      if (p) return p as Extract<typeof p, { type: "tool-call" }>;
    }
    throw new Error(`no tool-call part ${toolCallId}`);
  }
  const progressEvents = () =>
    events.filter((e): e is Extract<AgentEvent, { type: "agent-tool-progress" }> => e.type === "agent-tool-progress");
  const statusEvents = () => events.filter((e) => e.type === "agent-tool-status");

  afterEach(() => {
    jobProgressEmitter.removeAllListeners("job_progress");
    attachToolCallId.mockReset();
    kindMap.clear();
  });

  describe("codex: the _meta.mcp_output_delta shape codex-acp 1.10.0 sends", () => {
    beforeEach(() => setup("codex"));

    it("reads the delta as progress text for THAT call and patches the cached part", () => {
      announceCodex("call-A");
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-A", _meta: { mcp_output_delta: { data: "sleeping — 5/20s" } } });
      expect(progressEvents()).toEqual([expect.objectContaining({ toolCallId: "call-A", text: "sleeping — 5/20s" })]);
      expect(part("call-A").progress).toBe("sleeping — 5/20s");
    });

    it("a delta for a LATER call flips THAT call to running — never the oldest pending one", () => {
      announceCodex("call-A");
      announceCodex("call-B");
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-B", _meta: { mcp_output_delta: { data: "sleeping — 5/20s" } } });
      expect(part("call-B").status).toBe("running");
      expect(part("call-A").status).toBe("pending");
      expect(statusEvents()).toEqual([expect.objectContaining({ toolCallId: "call-B" })]);
    });

    it("a _meta-only update (no status, no content, no rawInput, no title) is not a refinement: nothing flips", () => {
      announceCodex("call-A");
      announceCodex("call-B");
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-B", _meta: { terminal_output: { data: "x" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-B", _meta: { mcp_output_delta: { data: "   " } } });
      expect(part("call-A").status).toBe("pending");
      expect(part("call-B").status).toBe("pending");
      expect(statusEvents()).toHaveLength(0);
      expect(progressEvents()).toHaveLength(0);
    });
  });

  describe("claude: elapsed time while a call has no text", () => {
    beforeEach(() => setup("claude-code"));
    const heartbeat = (toolCallId: string, elapsed?: number) =>
      update({
        sessionUpdate: "tool_call_update", toolCallId, status: "in_progress",
        _meta: { claudeCode: { toolName: "mcp__fal-ai__generate_video", ...(elapsed === undefined ? {} : { toolResponse: { elapsedTimeSeconds: elapsed } }) } },
      });

    it("a heartbeat's elapsedTimeSeconds becomes the progress line", () => {
      announceClaude("tu-1");
      heartbeat("tu-1", 12);
      expect(part("tu-1").progress).toBe("running for 12s");
      heartbeat("tu-1", 65);
      expect(progressEvents().map((e) => e.text)).toEqual(["running for 12s", "running for 1m 5s"]);
    });

    it("once the call has TEXT progress, later heartbeats never overwrite it", () => {
      announceClaude("tu-1");
      heartbeat("tu-1", 2);
      update({
        sessionUpdate: "tool_call_update", toolCallId: "tu-1", status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "rendering 3/10" } }],
      });
      heartbeat("tu-1", 9);
      expect(part("tu-1").progress).toBe("rendering 3/10");
    });

    it("a heartbeat without elapsedTimeSeconds adds no line", () => {
      announceClaude("tu-1");
      heartbeat("tu-1");
      expect(progressEvents()).toHaveLength(0);
    });
  });

  describe("the job_progress side channel: a non-job tool's verbatim message", () => {
    beforeEach(() => setup("claude-code"));
    const tick = () =>
      jobProgressEmitter.emit("job_progress", {
        jobId: "", kind: "", done: 5000, total: 20000, unit: "", etaMs: null,
        toolName: "libi.sleep", toolArgs: { seconds: 20 }, message: "sleeping — 5/20s",
      });

    it("routes by the tool hint, shows the message verbatim, and never touches JobManager", () => {
      announceClaude("tu-sleep", "mcp__libi__libi_sleep");
      const matcher = vi.fn(() => ({ session, toolCallId: "tu-sleep" }));
      handler.attachJobProgressBridge(() => undefined, matcher);
      tick();
      // The registered name resolves to libi's own server — a wrong canonical id fails here.
      expect(matcher).toHaveBeenCalledTimes(1);
      expect(matcher).toHaveBeenCalledWith(["libi:libi.sleep"], { seconds: 20 });
      const [ev] = progressEvents();
      expect(ev).toMatchObject({ toolCallId: "tu-sleep", text: "sleeping — 5/20s" });
      expect(ev).not.toHaveProperty("jobId");
      expect(part("tu-sleep").progress).toBe("sleeping — 5/20s");
      expect(part("tu-sleep").jobId).toBeUndefined();
      expect(attachToolCallId).not.toHaveBeenCalled();
    });

    it("a text tick suppresses the elapsed line afterwards", () => {
      announceClaude("tu-sleep", "mcp__libi__libi_sleep");
      const matcher = vi.fn(() => ({ session, toolCallId: "tu-sleep" }));
      handler.attachJobProgressBridge(() => undefined, matcher);
      tick();
      expect(matcher).toHaveBeenCalledWith(["libi:libi.sleep"], { seconds: 20 });
      update({ sessionUpdate: "tool_call_update", toolCallId: "tu-sleep", status: "in_progress", _meta: { claudeCode: { toolResponse: { elapsedTimeSeconds: 7 } } } });
      expect(part("tu-sleep").progress).toBe("sleeping — 5/20s");
    });

    it("a late tick for a call that already has its result touches nothing", () => {
      announceClaude("tu-sleep", "mcp__libi__libi_sleep");
      const matcher = vi.fn(() => ({ session, toolCallId: "tu-sleep" }));
      handler.attachJobProgressBridge((id) => (id === "tu-sleep" ? session : undefined), matcher);
      update({ sessionUpdate: "tool_call_update", toolCallId: "tu-sleep", status: "completed", rawOutput: "ok" });
      events.length = 0;
      // Keyed directly (claude's toolUseId) and by the name hint.
      jobProgressEmitter.emit("job_progress", {
        jobId: "", kind: "", done: 20000, total: 20000, unit: "", etaMs: null,
        toolCallId: "tu-sleep", toolName: "libi.sleep", toolArgs: { seconds: 20 }, message: "sleeping — 20/20s",
      });
      tick();
      expect(events).toHaveLength(0);
      expect(part("tu-sleep").progress).toBeUndefined();
      const tracked = (handler as unknown as { textProgressCalls: Set<string> }).textProgressCalls;
      expect(tracked.has("tu-sleep")).toBe(false);
    });
  });

  describe("the job_progress side channel: JOB ticks route exactly as before", () => {
    beforeEach(() => setup("claude-code"));

    it("a job whose kind has no chat surface never binds to the libi tool that enqueued it", () => {
      // e.g. proxy_gen — no mcpToolId, so absent from the kind map — enqueued while
      // libi.import_file runs, whose name the tick carries as its hint.
      announceClaude("tu-import", "mcp__libi__libi_import_file");
      const matcher = vi.fn(() => ({ session, toolCallId: "tu-import" }));
      handler.attachJobProgressBridge(() => undefined, matcher);
      events.length = 0;
      jobProgressEmitter.emit("job_progress", {
        jobId: "j1", kind: "proxy_gen", done: 1, total: 2, unit: "frames", etaMs: null,
        toolName: "libi.import_file", toolArgs: { path: "/a.mp4" },
      });
      expect(matcher).not.toHaveBeenCalled();
      expect(attachToolCallId).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
      expect(part("tu-import").progress).toBeUndefined();
      expect(part("tu-import").jobId).toBeUndefined();
    });

    it("a job whose kind IS mapped routes by that kind and binds the job to the row", () => {
      kindMap.set("tracking", ["libi:libi.track_object"]);
      announceClaude("tu-track", "mcp__libi__libi_track_object");
      const matcher = vi.fn(() => ({ session, toolCallId: "tu-track" }));
      handler.attachJobProgressBridge(() => undefined, matcher);
      jobProgressEmitter.emit("job_progress", {
        jobId: "j2", kind: "tracking", done: 5, total: 41, unit: "frames", etaMs: null,
        toolName: "libi.track_object", toolArgs: { objectId: "o1" },
      });
      expect(matcher).toHaveBeenCalledWith(["libi:libi.track_object"], { objectId: "o1" });
      expect(attachToolCallId).toHaveBeenCalledWith("j2", "tu-track");
      expect(progressEvents()).toEqual([
        expect.objectContaining({ toolCallId: "tu-track", text: "tracking 5/41 frames (12%)", jobId: "j2" }),
      ]);
      expect(part("tu-track")).toMatchObject({ progress: "tracking 5/41 frames (12%)", jobId: "j2", status: "running" });
    });
  });

  it("extractMcpOutputDelta / formatElapsedProgress", () => {
    expect(extractMcpOutputDelta({ _meta: { mcp_output_delta: { data: "  hi \n" } } })).toBe("hi");
    expect(extractMcpOutputDelta({ _meta: { mcp_output_delta: { data: 3 } } })).toBeNull();
    expect(extractMcpOutputDelta({ _meta: {} })).toBeNull();
    expect(extractMcpOutputDelta(null)).toBeNull();
    expect(formatElapsedProgress(0.4)).toBe("running for 0s");
    expect(formatElapsedProgress(125)).toBe("running for 2m 5s");
  });
});
