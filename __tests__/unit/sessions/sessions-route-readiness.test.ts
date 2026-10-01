/**
 * GET /api/sessions carries the active agent's readiness so a page load is
 * never blind: a `needs-auth` learned before the client attached its SSE
 * stream is otherwise never re-broadcast.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

const sm = {
  getAllSessions: vi.fn(() => []),
  activeAgentId: "codex" as string | null,
  isStandbyReady: vi.fn(() => false),
  getReadiness: vi.fn((_agentId?: string | null): AgentReadiness => ({ state: "unknown" })),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

let terminalActive = false;
vi.mock("@/lib/terminal/active-surface", () => ({
  isTerminalSurfaceActive: () => terminalActive,
}));

import { GET } from "@/app/api/sessions/route";

beforeEach(() => {
  vi.clearAllMocks();
  terminalActive = false;
  sm.activeAgentId = "codex";
  sm.getReadiness.mockReturnValue({ state: "unknown" });
});

describe("GET /api/sessions", () => {
  it("includes the active agent's readiness", async () => {
    sm.getReadiness.mockReturnValue({
      state: "needs-auth",
      agentId: "codex",
      message: "codex needs to be signed in before it can run that message.",
    });

    const body = await (await GET()).json();

    expect(sm.getReadiness).toHaveBeenCalledWith("codex");
    expect(body.readiness.state).toBe("needs-auth");
    expect(body.readiness.message).toBeTruthy();
  });

  it("says which chats' history is missing (SES-4), and nothing else changes shape", async () => {
    sm.getAllSessions.mockReturnValueOnce([
      { sessionId: "a", agentId: "claude-code", title: "A", updatedAt: null, active: false },
      { sessionId: "b", agentId: "claude-code", title: "B", updatedAt: null, active: false, historyMissing: true },
      { sessionId: "c", agentId: "codex", title: "C", updatedAt: null, active: false, historyUnlisted: true },
    ] as never);
    const body = await (await GET()).json();
    expect(body.sessions).toEqual([
      { sessionId: "a", agentId: "claude-code", title: "A", updatedAt: null, active: false, historyMissing: false, unlisted: false },
      { sessionId: "b", agentId: "claude-code", title: "B", updatedAt: null, active: false, historyMissing: true, unlisted: false },
      // Unlisted is not "history missing" (review I1): it only says the agent's listing left it out.
      { sessionId: "c", agentId: "codex", title: "C", updatedAt: null, active: false, historyMissing: false, unlisted: true },
    ]);
  });

  it("asks about the surface it reports as active", async () => {
    terminalActive = true;

    const body = await (await GET()).json();

    expect(body.activeAgentId).toBe("terminal");
    expect(sm.getReadiness).toHaveBeenCalledWith("terminal");
  });
});
