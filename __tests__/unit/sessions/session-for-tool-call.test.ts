import { vi, describe, it, expect } from "vitest";

/**
 * NAV-1: `SessionManager.sessionForToolCall` names the libi chat an agent's "show" navigation came
 * from — by Claude's toolUseId when the MCP child had one, else by the libi tool's name + args
 * against the chats' unresolved calls (Codex sends no id). A call no chat holds (a CLI agent's) is
 * null, and the navigation then reaches every tab as before.
 */

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));
vi.mock("@/lib/agents/libi-registration", () => ({ readLibiCodexEntryShape: vi.fn(async () => "unknown") }));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ clearSignInConfirmation: vi.fn() }));
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  getMcpServersForAcpFallback: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));
vi.mock("@/lib/sessions/standby-freshness", () => ({
  captureStandbyFreshness: vi.fn(() => ({ config: "d", setupEpoch: 0, setupLive: false })),
  staleStandbyReason: vi.fn(() => null),
}));
vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({ getAgentModelId: vi.fn(() => null), setAgentModelId: vi.fn() }));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: log, mcpLogger: log }));

import { SessionManager } from "@/lib/sessions/session-manager";

function smWith(parts: Array<{ toolCallId: string; toolId: string | null; args: unknown; done?: boolean }>) {
  const sm = new SessionManager();
  const conn = {
    listSessions: vi.fn(async () => ({ sessions: [{ sessionId: "chat-1", cwd: "/tmp/libi-test-agent" }, { sessionId: "chat-2", cwd: "/tmp/libi-test-agent" }], nextCursor: null })),
  };
  sm.setProcessManager({
    getConnection: vi.fn(() => conn as never),
    warmProcess: vi.fn(async () => {}),
    getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
  });
  return {
    sm,
    async ready() {
      await sm.loadInitialSessions("claude-code");
      sm.getSession("chat-2")!.messageCache.push({
        id: "a1",
        role: "agent",
        timestamp: 1,
        parts: parts.flatMap((p) => [
          { type: "tool-call" as const, toolCallId: p.toolCallId, toolId: p.toolId as never, rawTitle: "t", args: p.args },
          ...(p.done ? [{ type: "tool-result" as const, toolCallId: p.toolCallId, result: "ok" }] : []),
        ]) as never,
      });
      return sm;
    },
  };
}

describe("SessionManager.sessionForToolCall (NAV-1)", () => {
  it("finds the chat by Claude's toolUseId", async () => {
    const sm = await smWith([{ toolCallId: "toolu_1", toolId: "libi:libi.show_templates", args: {} }]).ready();
    expect(sm.sessionForToolCall({ toolCallId: "toolu_1", toolName: "libi.show_templates" })).toBe("chat-2");
  });

  it("finds it by the libi tool's name + args when there is no id (Codex)", async () => {
    const sm = await smWith([{ toolCallId: "call_x", toolId: "libi:libi.show_extension", args: { extensionId: "whisper" } }]).ready();
    expect(sm.sessionForToolCall({ toolName: "libi.show_extension", toolArgs: { extensionId: "whisper" } })).toBe("chat-2");
    // Another libi tool that no chat is running is not this chat's.
    expect(sm.sessionForToolCall({ toolName: "libi.show_templates", toolArgs: {} })).toBeNull();
  });

  it("a call no libi chat holds (a CLI agent's), or one already answered, is null", async () => {
    const sm = await smWith([{ toolCallId: "call_y", toolId: "libi:libi.show_templates", args: {}, done: true }]).ready();
    expect(sm.sessionForToolCall({ toolCallId: "toolu_unknown", toolName: "libi.show_templates", toolArgs: {} })).toBeNull();
    expect(sm.sessionForToolCall({})).toBeNull();
  });
});
