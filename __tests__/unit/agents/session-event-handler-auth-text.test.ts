/**
 * Claude Code has reported an expired OAuth session as reply TEXT — "Failed to
 * authenticate: OAuth session expired and could not be refreshed" — inside a turn
 * that otherwise succeeded (Windows QA VM, claude 2.1.267), never as the ACP −32000
 * that `isAuthRequiredError` matches. The evidence is narrative-only (that VM output
 * was not saved) and is to be re-verified on a real expired sign-in, so the match is
 * deliberately narrow: the FIRST part of a live claude-code turn must START with the
 * prefix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({ getJobIdForToolCallId: () => null, attachToolCallId: () => {}, on: () => {}, off: () => {} }),
}));
vi.mock("@/lib/db/settings", () => ({ getNotificationsSetting: () => ({ backgroundJobComplete: false }) }));

import { CLAUDE_AUTH_FAILURE_TEXT_PREFIX, SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";

function makeSession(agentId: string, isReplaying = false): SessionEntry {
  return {
    sessionId: "s1", agentId, title: null, updatedAt: null, active: true, lastUsed: Date.now(),
    messageCache: [], currentAgentMessage: null, currentUserMessage: null, listeners: new Set(),
    pendingApprovals: new Map(), configOptions: [], latestUsage: null, availableCommands: [],
    ...(isReplaying ? { isReplaying: true } : {}),
  };
}

const chunk = (text: string) =>
  ({ sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }) as never;

describe("Claude's expired-OAuth reply text is an observed auth rejection (narrow match)", () => {
  let onAuthRejectedText: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  const handlerFor = (session: SessionEntry) =>
    new SessionEventHandler({ next: () => 0 }, () => {}, () => session, undefined, undefined, onAuthRejectedText);
  beforeEach(() => {
    onAuthRejectedText = vi.fn<(sessionId: string) => void>();
  });

  it("the prefix is exactly what was observed", () => {
    expect(CLAUDE_AUTH_FAILURE_TEXT_PREFIX).toBe("Failed to authenticate");
  });

  it("fires once when the turn OPENS with the prefix, even when the prefix spans chunks", () => {
    const h = handlerFor(makeSession("claude-code"));
    h.handleSessionUpdate("s1", chunk("Failed to auth"));
    expect(onAuthRejectedText).not.toHaveBeenCalled();
    h.handleSessionUpdate("s1", chunk("enticate: OAuth session expired and could not be refreshed"));
    h.handleSessionUpdate("s1", chunk(" More text."));
    expect(onAuthRejectedText).toHaveBeenCalledTimes(1);
    expect(onAuthRejectedText).toHaveBeenCalledWith("s1");
  });

  it("never fires for the prefix anywhere else in a reply", () => {
    handlerFor(makeSession("claude-code")).handleSessionUpdate("s1", chunk("The log says: Failed to authenticate: OAuth session expired"));
    expect(onAuthRejectedText).not.toHaveBeenCalled();
  });

  it("never fires when the turn did not open with text (a tool call came first)", () => {
    const h = handlerFor(makeSession("claude-code"));
    h.handleSessionUpdate("s1", { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "libi.list_pieces", rawInput: {} } } as never);
    h.handleSessionUpdate("s1", chunk("Failed to authenticate: OAuth session expired"));
    expect(onAuthRejectedText).not.toHaveBeenCalled();
  });

  it("never fires for a reply that ends before the prefix length", () => {
    handlerFor(makeSession("claude-code")).handleSessionUpdate("s1", chunk("Failed"));
    expect(onAuthRejectedText).not.toHaveBeenCalled();
  });

  it("never fires for codex (it rejects at session/new) or during a loadSession replay", () => {
    handlerFor(makeSession("codex")).handleSessionUpdate("s1", chunk("Failed to authenticate: x"));
    handlerFor(makeSession("claude-code", true)).handleSessionUpdate("s1", chunk("Failed to authenticate: x"));
    expect(onAuthRejectedText).not.toHaveBeenCalled();
  });
});
