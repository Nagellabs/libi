/**
 * On every new SSE connection the route announces each active session's
 * status. It used to announce `connected` for ALL of them — including a
 * session whose prompt was still running — so any EventSource reconnect
 * during a turn (sleep/wake, a network blip, a dev recompile, a page reload)
 * flipped a working chat to idle: the Stop button vanished and a new message
 * took the plain send path instead of steering. Observed 2026-09-25
 * (docs-local/qa/2026-09-25-viral-explainer-session.md, bug 3).
 *
 * A busy session is announced as `streaming` — the client's mid-turn status —
 * never `thinking`, which the client treats as a turn START and would split
 * the in-flight reply in two.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sm = vi.hoisted(() => ({
  getActiveSessionIds: vi.fn(() => [] as string[]),
  getSession: vi.fn<(id: string) => unknown>(() => undefined),
}));

vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    getActiveSessionIds: sm.getActiveSessionIds,
    getSession: sm.getSession,
    onGlobalEvent: vi.fn(),
    offGlobalEvent: vi.fn(),
    onSystemEvent: vi.fn(),
    offSystemEvent: vi.fn(),
  }),
}));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { on: vi.fn(), off: vi.fn() },
}));

/** Read the stream until `count` data frames have arrived. */
async function dataFrames(res: Response, count: number): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Record<string, unknown>[] = [];
  const deadline = Date.now() + 2000;
  try {
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe("GET /api/agent/events — per-session status on (re)connect", () => {
  beforeEach(() => {
    sm.getActiveSessionIds.mockReset();
    sm.getSession.mockReset();
  });

  it("announces a session mid-turn as streaming and an idle one as connected", async () => {
    sm.getActiveSessionIds.mockReturnValue(["busy", "idle"]);
    // Real entries, read through the real `isSessionMidTurn` predicate. The
    // idle one carries a stale assembly cursor (a late chunk after its turn):
    // it must still read idle — the prompt counter decides, not the cursor.
    sm.getSession.mockImplementation((id: string) => ({
      sessionId: id,
      active: true,
      promptsInFlight: id === "busy" ? 1 : 0,
      currentAgentMessage: { id: "agent_1", role: "agent", parts: [], timestamp: 1 },
      pendingApprovals: new Map(),
    }));
    const { GET } = await import("@/app/api/agent/events/route");
    const res = await GET(new Request("http://localhost/api/agent/events"));
    const frames = await dataFrames(res, 2);

    const statusOf = (sid: string) =>
      frames.find((f) => f.sessionId === sid && f.type === "agent-status")?.status;
    expect(statusOf("busy")).toBe("streaming");
    expect(statusOf("idle")).toBe("connected");
    // Never a turn-start frame on reconnect.
    expect(frames.some((f) => f.status === "thinking")).toBe(false);
  });

  // A turn blocked on an approval is busy — so after a reload the chat shows
  // Stop, and without the card the user has no way to answer it: the agent
  // waits forever. The request is emit-only (never in the message cache), so
  // the (re)connect has to re-announce it.
  it("re-announces each pending approval after the session's status frame", async () => {
    const toolCall = { toolCallId: "tc-9", title: "Bash", rawInput: { command: "rm -rf build" } };
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    sm.getActiveSessionIds.mockReturnValue(["waiting"]);
    sm.getSession.mockImplementation((id: string) => ({
      sessionId: id,
      active: true,
      promptsInFlight: 1,
      currentAgentMessage: null,
      pendingApprovals: new Map([
        ["p-2", { pendingId: "p-2", toolCall, options, reason: "extension", createdAt: 20, resolve: () => {} }],
        ["p-1", { pendingId: "p-1", toolCall, options, createdAt: 10, resolve: () => {} }],
      ]),
    }));
    const { GET } = await import("@/app/api/agent/events/route");
    const res = await GET(new Request("http://localhost/api/agent/events"));
    const frames = await dataFrames(res, 3);

    expect(frames.map((f) => [f.type, f.pendingId ?? f.status])).toEqual([
      ["agent-status", "streaming"],
      ["agent-permission-request", "p-1"], // oldest first
      ["agent-permission-request", "p-2"],
    ]);
    expect(frames[1]).toMatchObject({ sessionId: "waiting", toolCall, options, reason: "acp" });
    expect(frames[2]).toMatchObject({ reason: "extension" });
    // The resolver never goes on the wire.
    expect(frames[1]).not.toHaveProperty("resolve");
  });
});
