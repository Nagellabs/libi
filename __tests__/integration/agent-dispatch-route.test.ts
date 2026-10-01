import { describe, it, expect, vi, beforeEach } from "vitest";

const sm = {
  activeAgentId: null as string | null,
  switchAgent: vi.fn(async () => {}),
  createSession: vi.fn(async () => "s"),
  sendMessage: vi.fn(async () => {}),
  getSession: vi.fn<(id: string) => undefined>(() => undefined),
  hasActiveSession: vi.fn<(id: string) => boolean>(() => false),
  awaitApprovalMode: vi.fn(
    async (): Promise<
      { ok: true } | { ok: false; mode: "ask" | "auto"; error: string; retryable: boolean }
    > => ({ ok: true }),
  ),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));
vi.mock("@/lib/db/settings", () => ({ getSettings: () => ({ preferredAgent: null }) }));

import { POST } from "@/app/api/agent/dispatch/route";

beforeEach(() => {
  sm.activeAgentId = null;
  vi.clearAllMocks();
  sm.awaitApprovalMode.mockResolvedValue({ ok: true });
});

function req(body: unknown) {
  return new Request("http://x/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/dispatch", () => {
  it("returns 409 no_agent when no agent is configured (BYO-CLI)", async () => {
    const r = await POST(req({ prompt: "do it" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "no_agent" });
  });

  it("returns 400 when the prompt is empty", async () => {
    const r = await POST(req({ prompt: "   " }));
    expect(r.status).toBe(400);
  });

  it("dispatches and returns the sessionId when an agent is active", async () => {
    sm.activeAgentId = "claude-code";
    const r = await POST(req({ prompt: "do it" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, sessionId: "s" });
    expect(sm.sendMessage).toHaveBeenCalledWith("s", "do it");
  });

  it("a new chat whose approval mode is held: 503 naming the mode and the chat, and nothing is sent", async () => {
    sm.activeAgentId = "claude-code";
    sm.awaitApprovalMode.mockResolvedValue({
      ok: false,
      mode: "ask",
      error: "libi couldn't apply 'Ask each time' to this chat in time, so the message wasn't sent.",
      retryable: true,
    });
    const r = await POST(req({ prompt: "do it" }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      error: "libi couldn't apply 'Ask each time' to this chat in time, so the message wasn't sent.",
      approvalModeNotApplied: "ask",
      sessionId: "s",
    });
    expect(sm.sendMessage).not.toHaveBeenCalled();
  });
});
