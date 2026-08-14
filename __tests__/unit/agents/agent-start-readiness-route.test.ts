/**
 * POST /api/agent/start must stop lying.
 *
 * It used to fire-and-forget `sm.switchAgent(providerId).catch(console.error)`
 * and return `200 {success:true}` before the switch had done anything, so an
 * agent that could not start was indistinguishable from one that did. These
 * tests pin the awaited behaviour and the readiness field the UI reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

const sm = {
  switchAgent: vi.fn(
    async (
      _agentId: string,
      _opts?: { awaitStandbyMs?: number },
    ): Promise<AgentReadiness> => ({ state: "ready" }),
  ),
  getReadiness: vi.fn((_agentId?: string | null): AgentReadiness => ({
    state: "unknown",
  })),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

const updateSettings = vi.fn();
vi.mock("@/lib/db/settings", () => ({ updateSettings: (...a: unknown[]) => updateSettings(...a) }));

let installed = true;
vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: (id: string) =>
    installed
      ? { id, installed: true }
      : {
          id,
          installed: false,
          unavailableReason: { code: "not_installed", message: "Codex is still installing." },
        },
}));

vi.mock("@/lib/terminal/active-surface", () => ({
  setTerminalSurfaceActive: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/agent/start/route";

function req(body: unknown) {
  return new Request("http://x/api/agent/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installed = true;
  sm.switchAgent.mockResolvedValue({ state: "ready" });
  sm.getReadiness.mockReturnValue({ state: "unknown" });
});

describe("POST /api/agent/start", () => {
  it("awaits the switch and reports the resulting readiness", async () => {
    sm.switchAgent.mockResolvedValue({ state: "ready" });

    const r = await POST(req({ providerId: "codex" }));

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      success: true,
      providerId: "codex",
      readiness: { state: "ready" },
    });
    // Awaited, not fire-and-forget — and with a standby budget, because for
    // codex the standby IS the session/new that can report needs-auth.
    expect(sm.switchAgent).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ awaitStandbyMs: expect.any(Number) }),
    );
  });

  it("surfaces needs-auth in the response instead of a bare success", async () => {
    sm.switchAgent.mockResolvedValue({
      state: "needs-auth",
      agentId: "codex",
      message: "codex needs to be signed in before it can run that message.",
      remedy: { label: "Sign in to Codex", command: "/x/codex login", detail: "d" },
    });

    const r = await POST(req({ providerId: "codex" }));
    const body = await r.json();

    expect(body.readiness.state).toBe("needs-auth");
    expect(body.readiness.message).toBeTruthy();
    expect(body.readiness.remedy.command).toBe("/x/codex login");
  });

  it("reports a failed switch rather than claiming success", async () => {
    sm.switchAgent.mockRejectedValue(new Error("spawn ENOENT"));
    sm.getReadiness.mockReturnValue({ state: "unknown" });

    const r = await POST(req({ providerId: "codex" }));
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/spawn ENOENT/);
    expect(body.readiness).toEqual({ state: "unknown" });
  });

  it("returns not-installed readiness for an unavailable agent", async () => {
    installed = false;

    const r = await POST(req({ providerId: "codex" }));
    const body = await r.json();

    expect(r.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.readiness).toEqual({
      state: "not-installed",
      reason: "Codex is still installing.",
    });
    expect(sm.switchAgent).not.toHaveBeenCalled();
  });

  it("answers unknown for the Terminal surface — it warms no ACP process", async () => {
    const r = await POST(req({ providerId: "terminal" }));

    expect(await r.json()).toEqual({
      success: true,
      providerId: "terminal",
      readiness: { state: "unknown" },
    });
    expect(sm.switchAgent).not.toHaveBeenCalled();
  });
});
