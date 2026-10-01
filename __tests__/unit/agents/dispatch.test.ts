import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NoAgentConfiguredError,
  ApprovalModeHeldError,
  DispatchChatTakenError,
} from "@/lib/agents/errors";

const sm = {
  activeAgentId: null as string | null,
  switchAgent: vi.fn(async () => {}),
  createSession: vi.fn(async () => "sess-1"),
  sendMessage: vi.fn(async () => {}),
  getSession: vi.fn<
    (
      id: string,
    ) => { agentId: string; messageCache: Array<{ role: string }>; userSent?: boolean } | undefined
  >(() => undefined),
  hasActiveSession: vi.fn<(id: string) => boolean>(() => true),
  awaitApprovalMode: vi.fn(
    async (): Promise<
      | { ok: true }
      | { ok: false; mode: "ask" | "auto" | "auto-with-generations"; error: string; retryable: boolean }
    > => ({ ok: true }),
  ),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));
vi.mock("@/lib/db/settings", () => ({ getSettings: () => ({ preferredAgent: null }) }));

import { dispatchToAgent, resetHeldDispatchChatForTest } from "@/lib/agents/dispatch";

beforeEach(() => {
  sm.activeAgentId = null;
  vi.clearAllMocks();
  sm.awaitApprovalMode.mockResolvedValue({ ok: true });
  sm.getSession.mockReturnValue(undefined);
  sm.hasActiveSession.mockReturnValue(true);
  sm.createSession.mockResolvedValue("sess-1");
  resetHeldDispatchChatForTest();
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

  it("a new chat whose approval mode is held rejects before sending, and sends nothing", async () => {
    sm.activeAgentId = "claude-code";
    const gate = {
      ok: false as const,
      mode: "ask" as const,
      error: "libi couldn't apply 'Ask each time' to this chat in time, so the message wasn't sent.",
      retryable: true,
    };
    sm.awaitApprovalMode.mockResolvedValue(gate);
    const err = await dispatchToAgent({ prompt: "make a thing" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalModeHeldError);
    expect((err as ApprovalModeHeldError).gate).toEqual(gate);
    expect((err as ApprovalModeHeldError).sessionId).toBe("sess-1");
    expect((err as ApprovalModeHeldError).message).toBe(gate.error);
    expect(sm.awaitApprovalMode).toHaveBeenCalledWith("sess-1");
    expect(sm.sendMessage).not.toHaveBeenCalled();
  });

  it("waits for the new chat's approval mode before sending", async () => {
    sm.activeAgentId = "claude-code";
    await dispatchToAgent({ prompt: "make a thing" });
    expect(sm.awaitApprovalMode.mock.invocationCallOrder[0]).toBeLessThan(
      sm.sendMessage.mock.invocationCallOrder[0],
    );
  });

  describe("a held dispatch's empty chat is reused, not piled up (NQ-7 review)", () => {
    const held = {
      ok: false as const,
      mode: "ask" as const,
      error: "held",
      retryable: true,
    };

    it("the next dispatch retries in the same untouched chat instead of creating another", async () => {
      sm.activeAgentId = "claude-code";
      sm.awaitApprovalMode.mockResolvedValueOnce(held);
      await expect(dispatchToAgent({ prompt: "one" })).rejects.toBeInstanceOf(ApprovalModeHeldError);
      expect(sm.createSession).toHaveBeenCalledTimes(1);

      sm.getSession.mockReturnValue({ agentId: "claude-code", messageCache: [{ role: "agent" }] });
      const r = await dispatchToAgent({ prompt: "two" });
      expect(r.sessionId).toBe("sess-1");
      expect(sm.createSession).toHaveBeenCalledTimes(1);
      expect(sm.sendMessage).toHaveBeenCalledWith("sess-1", "two");

      // Once it went out, the chat is the user's: the next dispatch opens a fresh one.
      sm.createSession.mockResolvedValueOnce("sess-2");
      expect((await dispatchToAgent({ prompt: "three" })).sessionId).toBe("sess-2");
    });

    it("not reused when the user wrote in it, it isn't active, the agent changed, or the hold can't be retried", async () => {
      sm.activeAgentId = "claude-code";
      const reusedAfter = async (setup: () => void, gate = held) => {
        resetHeldDispatchChatForTest();
        sm.createSession.mockClear();
        sm.awaitApprovalMode.mockResolvedValueOnce(gate);
        await dispatchToAgent({ prompt: "one" }).catch(() => {});
        sm.getSession.mockReturnValue({ agentId: "claude-code", messageCache: [] });
        sm.hasActiveSession.mockReturnValue(true);
        setup();
        await dispatchToAgent({ prompt: "two" });
        return sm.createSession.mock.calls.length === 1;
      };
      expect(await reusedAfter(() => {})).toBe(true);
      expect(
        await reusedAfter(() =>
          sm.getSession.mockReturnValue({ agentId: "claude-code", messageCache: [{ role: "user" }] }),
        ),
      ).toBe(false);
      expect(await reusedAfter(() => sm.hasActiveSession.mockReturnValue(false))).toBe(false);
      // The user typed into it: held, so no user message is cached, but it is theirs now.
      expect(
        await reusedAfter(() =>
          sm.getSession.mockReturnValue({ agentId: "claude-code", messageCache: [], userSent: true }),
        ),
      ).toBe(false);
      expect(
        await reusedAfter(() =>
          sm.getSession.mockReturnValue({ agentId: "codex", messageCache: [] }),
        ),
      ).toBe(false);
      expect(await reusedAfter(() => {}, { ...held, retryable: false })).toBe(false);
    });

    it("the user writes in the taken chat while the dispatch waits on its gate: the dispatch sends nothing", async () => {
      sm.activeAgentId = "claude-code";
      sm.awaitApprovalMode.mockResolvedValueOnce(held);
      await dispatchToAgent({ prompt: "one" }).catch(() => {});
      const chat = { agentId: "claude-code", messageCache: [] as Array<{ role: string }>, userSent: false };
      sm.getSession.mockReturnValue(chat);
      sm.awaitApprovalMode.mockImplementationOnce(async () => {
        chat.userSent = true; // the user's own send got there first
        return { ok: true };
      });
      const err = await dispatchToAgent({ prompt: "two" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchChatTakenError);
      expect((err as DispatchChatTakenError).sessionId).toBe("sess-1");
      expect(sm.sendMessage).not.toHaveBeenCalled();
    });
  });
});
