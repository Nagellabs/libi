import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoAgentConfiguredError } from "@/lib/agents/errors";

const sm = {
  activeAgentId: null as string | null,
  switchAgent: vi.fn(async () => {}),
  createSession: vi.fn(async () => "sess-1"),
  sendMessage: vi.fn(async () => {}),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));
vi.mock("@/lib/db/settings", () => ({ getSettings: () => ({ preferredAgent: null }) }));

import { dispatchToAgent } from "@/lib/agents/dispatch";

beforeEach(() => {
  sm.activeAgentId = null;
  vi.clearAllMocks();
});

describe("dispatchToAgent", () => {
  it("throws NoAgentConfiguredError when no active or preferred agent", async () => {
    await expect(dispatchToAgent({ prompt: "hi" })).rejects.toBeInstanceOf(
      NoAgentConfiguredError,
    );
    expect(sm.createSession).not.toHaveBeenCalled();
  });

  it("creates a session and sends the prompt when an agent is active", async () => {
    sm.activeAgentId = "claude-code";
    const r = await dispatchToAgent({ prompt: "make a thing" });
    expect(r.sessionId).toBe("sess-1");
    expect(sm.sendMessage).toHaveBeenCalledWith("sess-1", "make a thing");
  });

  it("honors an explicit agentId override", async () => {
    const r = await dispatchToAgent({ prompt: "x", agentId: "codex" });
    expect(sm.switchAgent).toHaveBeenCalledWith("codex");
    expect(r.sessionId).toBe("sess-1");
  });
});
