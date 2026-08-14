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
      remedy: null,
    });

    const body = await (await GET()).json();

    expect(sm.getReadiness).toHaveBeenCalledWith("codex");
    expect(body.readiness.state).toBe("needs-auth");
    expect(body.readiness.message).toBeTruthy();
  });

  it("asks about the surface it reports as active", async () => {
    terminalActive = true;

    const body = await (await GET()).json();

    expect(body.activeAgentId).toBe("terminal");
    expect(sm.getReadiness).toHaveBeenCalledWith("terminal");
  });
});
