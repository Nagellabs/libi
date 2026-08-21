/**
 * A chat tool-call row must go terminal when its JOB ends, even if no tool
 * result ever arrives.
 *
 * Reproduces session 9c3ce4d0 (2026-08-17): the user interrupted a running
 * `libi.music_download_model`, Claude Code cancelled the tool call, and no
 * result was delivered — but the server-side download kept going and kept
 * streaming progress to the same toolCallId. The row climbed to 100% and then
 * spun forever, still offering "stop", with its elapsed timer past 28 minutes on
 * a job that had already finished.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({
  notify: { jobProgress: vi.fn() },
  pushIfBackgrounded: vi.fn(),
}));
vi.mock("@/lib/db/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/settings")>();
  return {
    ...original,
    // Off: this file is about the chat row, not the push notification.
    getNotificationsSetting: vi.fn(() => ({ backgroundJobComplete: false })),
  };
});

import { getJobManager } from "@/lib/jobs/manager";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import type { AgentMessage } from "@/lib/agents/message-types";

const TOOL_CALL_ID = "toolu_interrupted";

interface Harness {
  handler: SessionEventHandler;
  agentMsg: AgentMessage;
  emitted: Array<{ sessionId: string; event: { type: string } }>;
}

/** A session whose tool-call part is still `running` and has NO tool-result —
 *  the exact state the interrupt left behind. */
function makeHarness(opts: { withResult?: boolean } = {}): Harness {
  const agentMsg = {
    id: "msg-1",
    role: "agent",
    parts: [
      {
        type: "tool-call",
        toolCallId: TOOL_CALL_ID,
        toolId: null,
        rawTitle: "Libi Music download model",
        status: "running",
        runningAt: Date.now() - 28 * 60_000,
        progress: "music_model_download 7892/7892 MB (100%)",
      },
      ...(opts.withResult
        ? [
            {
              type: "tool-result",
              toolCallId: TOOL_CALL_ID,
              toolId: null,
              rawTitle: "",
              result: "the real result",
              success: true,
              completedAt: Date.now(),
            },
          ]
        : []),
    ],
    timestamp: Date.now(),
  } as unknown as AgentMessage;

  const session = {
    sessionId: "sess-1",
    messageCache: [agentMsg],
  };

  const emitted: Array<{ sessionId: string; event: { type: string } }> = [];
  let counter = 0;
  const handler = new SessionEventHandler(
    { next: () => ++counter } as never,
    ((sessionId: string, event: { type: string }) =>
      emitted.push({ sessionId, event })) as never,
    (() => undefined) as never,
  );
  handler.attachJobProgressBridge(
    ((id: string) => (id === TOOL_CALL_ID ? session : undefined)) as never,
    (() => undefined) as never,
  );
  return { handler, agentMsg, emitted };
}

function resultParts(agentMsg: AgentMessage) {
  return agentMsg.parts.filter((p) => p.type === "tool-result");
}

describe("closing a tool-call row whose job ended without a tool result", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    const mgr = getJobManager();
    mgr.removeAllListeners("completed");
    mgr.removeAllListeners("failed");
    mgr.removeAllListeners("cancelled");
  });

  it("writes a result so the row stops spinning", async () => {
    const { agentMsg, emitted } = makeHarness();
    const mgr = getJobManager();

    mgr.emit("completed", {
      jobId: "job-1",
      result: {},
      toolCallIds: [TOOL_CALL_ID],
    });

    // Nothing yet — the grace window lets the healthy path land first.
    expect(resultParts(agentMsg)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(9_000);

    const results = resultParts(agentMsg);
    expect(results).toHaveLength(1);
    expect((results[0] as { success: boolean }).success).toBe(true);
    expect((results[0] as { result: string }).result).toMatch(/background/i);
    expect((results[0] as { completedAt?: number }).completedAt).toBeTypeOf(
      "number",
    );

    // The transient status has to go too: a part with BOTH a result and
    // status:"running" renders as done and running at once.
    const call = agentMsg.parts.find((p) => p.type === "tool-call") as {
      status?: string;
    };
    expect(call.status).toBeUndefined();

    // And the live UI is told, not just the cache — otherwise the row only
    // fixes itself on a page refresh.
    expect(
      emitted.some((e) => e.event.type === "agent-tool-result"),
    ).toBe(true);
  });

  it("leaves a real tool result untouched (the healthy case)", async () => {
    const { agentMsg } = makeHarness({ withResult: true });
    const mgr = getJobManager();

    mgr.emit("completed", {
      jobId: "job-1",
      result: {},
      toolCallIds: [TOOL_CALL_ID],
    });
    await vi.advanceTimersByTimeAsync(9_000);

    const results = resultParts(agentMsg);
    expect(results).toHaveLength(1);
    expect((results[0] as { result: string }).result).toBe("the real result");
  });

  it("surfaces the error when the job failed", async () => {
    const { agentMsg } = makeHarness();
    const mgr = getJobManager();

    mgr.emit("failed", {
      jobId: "job-1",
      error: "disk full",
      toolCallIds: [TOOL_CALL_ID],
    });
    await vi.advanceTimersByTimeAsync(9_000);

    const results = resultParts(agentMsg);
    expect(results).toHaveLength(1);
    expect((results[0] as { success: boolean }).success).toBe(false);
    expect((results[0] as { result: string }).result).toContain("disk full");
  });

  it("closes the row on cancellation too", async () => {
    const { agentMsg } = makeHarness();
    const mgr = getJobManager();

    mgr.emit("cancelled", { jobId: "job-1", toolCallIds: [TOOL_CALL_ID] });
    await vi.advanceTimersByTimeAsync(9_000);

    const results = resultParts(agentMsg);
    expect(results).toHaveLength(1);
    expect((results[0] as { success: boolean }).success).toBe(false);
  });

  it("does nothing when the job carried no toolCallIds", async () => {
    const { agentMsg } = makeHarness();
    const mgr = getJobManager();

    // An internal runner (proxy_gen, filmstrip) has no chat surface at all.
    mgr.emit("completed", { jobId: "job-1", result: {}, toolCallIds: [] });
    await vi.advanceTimersByTimeAsync(9_000);

    expect(resultParts(agentMsg)).toHaveLength(0);
  });

  it("does not fire after the bridge is detached", async () => {
    const { handler, agentMsg } = makeHarness();
    const mgr = getJobManager();

    mgr.emit("completed", {
      jobId: "job-1",
      result: {},
      toolCallIds: [TOOL_CALL_ID],
    });
    // Re-attaching (HMR) rebuilds the closures; a pending finalizer would be
    // patching a message cache from the previous generation.
    handler.attachJobProgressBridge(
      (() => undefined) as never,
      (() => undefined) as never,
    );
    await vi.advanceTimersByTimeAsync(9_000);

    expect(resultParts(agentMsg)).toHaveLength(0);
  });
});
