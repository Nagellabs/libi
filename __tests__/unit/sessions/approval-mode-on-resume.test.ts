/**
 * The saved approval mode is re-applied to a chat resumed after a libi restart.
 *
 * Full-verification F5 (Ap5, 0.1.16): after a restart, a chat resumed through
 * `session/load` ran with NO approval mode pushed. Its entry was rebuilt from
 * `listSessions`, so it had no cached `availableModes`; the resume push passed
 * `undefined`, `acpModeFor` returned null, and the push was skipped with a
 * warning. The resumed Claude session then ran in the user's own
 * `permissions.defaultMode` (`auto` on the owner's Mac): with the picker on
 * "Ask each time", `libi.update_piece` ran with no approval card.
 *
 * Every entry here comes from `listSessions` only — no `newSession` happened
 * in this process unless a test says so — which is exactly the state after a
 * restart.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => {
  const fake = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return {
    serverLogger: fake(),
    mcpLogger: fake(),
    ffmpegLogger: fake(),
    mediabunnyLogger: fake(),
    proxyLogger: fake(),
    exportLogger: fake(),
    overlayLogger: fake(),
    scriptAnalysisLogger: fake(),
  };
});

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));

vi.mock("@/lib/agents/sign-in-confirmation", () => ({ clearSignInConfirmation: vi.fn() }));

vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  getMcpServersForAcpFallback: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));

vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "ask") }));

vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));

vi.mock("@/lib/sessions/standby-freshness", () => ({
  captureStandbyFreshness: vi.fn(() => ({ config: "c", setupEpoch: 0, setupLive: false })),
  staleStandbyReason: vi.fn(() => null),
}));

vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));

// The codex entry-shape diagnostic is fire-and-forget; keep it from spawning codex.
vi.mock("@/lib/codex-config/codex-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-config/codex-cli")>()),
  mcpListJson: vi.fn(async () => []),
}));
vi.mock("@/lib/agents/cli/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/cli/resolve")>()),
  resolveAgentCli: vi.fn(async () => null),
}));
vi.mock("@/lib/codex-config/canonical", () => ({
  resolveCodexHome: vi.fn(() => "/tmp/libi-test-codex-home"),
}));

import { SessionManager } from "@/lib/sessions/session-manager";
import { getApprovalMode } from "@/lib/approval/settings";
import { getAgentModelId } from "@/lib/sessions/model-preferences";
import { serverLogger } from "@/lib/logger";
import type { ApprovalMode } from "@/lib/approval/mode";
import type { AgentEvent } from "@/lib/agents/types";

/** The real `availableModes` shapes each adapter advertises. */
const CLAUDE_MODES = [
  { id: "default" },
  { id: "acceptEdits" },
  { id: "plan" },
  { id: "bypassPermissions" },
];
const CODEX_MODES = [{ id: "read-only" }, { id: "agent" }, { id: "agent-full-access" }];

// Codex with nothing known about its modes: a retry alone can't help, so the way out is a new chat.
const NOTICE_ASK =
  "libi doesn't know which approval modes this agent offers, so it couldn't apply 'Ask each time' to this resumed chat and won't send messages here — start a new chat to be asked before each tool.";

type LoadResult =
  | { modes?: { currentModeId: string; availableModes: { id: string }[] }; configOptions?: unknown[] }
  | undefined;

function createHarness(opts: {
  agentId: "claude-code" | "codex";
  pastSessions: string[];
  loadResult?: LoadResult;
  newSessionResult?: unknown;
}) {
  const conn = {
    listSessions: vi.fn().mockResolvedValue({
      sessions: opts.pastSessions.map((sessionId) => ({
        sessionId,
        cwd: "/tmp/libi-test-agent",
        title: `chat ${sessionId}`,
        updatedAt: "2026-09-26T10:00:00.000Z",
      })),
      nextCursor: null,
    }),
    newSession: vi.fn().mockResolvedValue(opts.newSessionResult ?? { sessionId: "standby-1" }),
    loadSession: vi.fn().mockResolvedValue(opts.loadResult),
    closeSession: vi.fn().mockResolvedValue(undefined),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
  };
  const pm = {
    getConnection: vi.fn().mockReturnValue(conn),
    warmProcess: vi.fn().mockResolvedValue(undefined),
    getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: true }),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
  };
  const sm = new SessionManager();
  sm.setProcessManager(pm);
  const events: Array<{ sessionId: string; event: AgentEvent }> = [];
  sm.onGlobalEvent((sessionId, event) => events.push({ sessionId, event }));
  return { sm, conn, pm, events };
}

function opsAt(level: "warn" | "error"): string[] {
  return vi
    .mocked(serverLogger[level])
    .mock.calls.map((c) => (c[0] as { op?: string })?.op ?? "");
}

function setMode(mode: ApprovalMode) {
  vi.mocked(getApprovalMode).mockReturnValue(mode);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("restart → resume: the saved approval mode is pushed again", () => {
  it("Ask on Claude, load response WITHOUT modes and nothing cached: still pushes Claude's `default`", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-1"] });
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-1");

    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-1", modeId: "default" });
    expect(opsAt("warn")).not.toContain("approval_mode_unsupported_by_agent");
    expect(opsAt("error")).not.toContain("approval_mode_not_applied");
  });

  it("uses the `modes` the load response carries, and stores them on the entry", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-x"],
      loadResult: { modes: { currentModeId: "agent", availableModes: CODEX_MODES } },
    });
    await sm.loadInitialSessions("codex");

    await sm.activateSession("old-x");

    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-x", modeId: "read-only" });
    expect(sm.getSession("old-x")?.availableModes).toEqual(CODEX_MODES);
  });

  it("per-agent cache: modes a standby's `newSession` advertised serve a later resume of a DIFFERENT chat", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-y"],
      newSessionResult: {
        sessionId: "standby-1",
        modes: { currentModeId: "agent", availableModes: CODEX_MODES },
      },
      // The load answers without modes, so only the per-agent cache can know them.
      loadResult: undefined,
    });
    await sm.loadInitialSessions("codex");
    await sm.createStandbySession();
    conn.setSessionMode.mockClear();

    await sm.activateSession("old-y");

    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-y", modeId: "read-only" });
  });

  it("Codex with NOTHING known: no blind push, one error-level `approval_mode_not_applied`, and the chat carries the notice", async () => {
    setMode("ask");
    const { sm, conn, events } = createHarness({
      agentId: "codex",
      pastSessions: ["old-z"],
      loadResult: undefined,
    });
    await sm.loadInitialSessions("codex");

    const history = await sm.activateSession("old-z");

    expect(conn.setSessionMode).not.toHaveBeenCalled();
    expect(opsAt("error").filter((op) => op === "approval_mode_not_applied")).toHaveLength(1);
    const errorCall = vi
      .mocked(serverLogger.error)
      .mock.calls.find((c) => (c[0] as { op?: string }).op === "approval_mode_not_applied");
    expect(errorCall?.[0]).toMatchObject({
      tag: "session-manager",
      agentId: "codex",
      sessionId: "old-z",
      mode: "ask",
    });

    const entry = sm.getSession("old-z");
    expect(entry?.approvalModeNotApplied).toBe("ask");
    // The notice is part of the chat's history, so a reload still shows it…
    const noteTexts = history.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
    );
    expect(noteTexts).toContain(NOTICE_ASK);
    // …and an open chat gets it live.
    expect(events).toContainEqual({
      sessionId: "old-z",
      event: expect.objectContaining({ type: "chat-note", text: NOTICE_ASK }),
    });
  });

  it("Auto, no extension prompts (`bypassPermissions`) is re-applied on resume from the load response", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-b"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-b");

    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: "old-b",
      modeId: "bypassPermissions",
    });
  });

  it("Auto, no extension prompts on Claude with nothing known: pushes `bypassPermissions` blind", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-c"] });
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-c");

    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: "old-c",
      modeId: "bypassPermissions",
    });
  });

  it("a Claude blind push the adapter REFUSES is a failure: error line and notice, and activation still succeeds", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-r"] });
    conn.setSessionMode.mockRejectedValueOnce(new Error("Invalid params"));
    await sm.loadInitialSessions("claude-code");

    await expect(sm.activateSession("old-r")).resolves.toBeDefined();

    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-r", modeId: "default" });
    expect(opsAt("error")).toContain("approval_mode_not_applied");
    expect(sm.getSession("old-r")?.approvalModeNotApplied).toBe("ask");
    expect(sm.getSession("old-r")?.active).toBe(true);
  });

  it("applyApprovalModeToActiveSessions uses the same resolution — and a successful push clears the notice flag", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-q"],
      loadResult: undefined,
    });
    await sm.loadInitialSessions("codex");
    await sm.activateSession("old-q");
    expect(sm.getSession("old-q")?.approvalModeNotApplied).toBe("ask");

    // A standby later advertises codex's vocabulary; the user flips the picker.
    conn.newSession.mockResolvedValueOnce({
      sessionId: "standby-2",
      modes: { currentModeId: "agent", availableModes: CODEX_MODES },
    });
    await sm.createStandbySession();
    conn.setSessionMode.mockClear();
    setMode("auto");

    await sm.applyApprovalModeToActiveSessions("codex");

    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-q", modeId: "agent" });
    expect(sm.getSession("old-q")?.approvalModeNotApplied).toBeUndefined();
  });
});

describe("only the documented root degrade is quiet (review M2)", () => {
  it("Auto on a resumed Claude chat whose known set lacks `default`: error line and notice, not a quiet warning", async () => {
    setMode("auto");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-m2"],
      loadResult: {
        modes: { currentModeId: "plan", availableModes: [{ id: "acceptEdits" }, { id: "plan" }] },
      },
    });
    await sm.loadInitialSessions("claude-code");

    const history = await sm.activateSession("old-m2");

    expect(conn.setSessionMode).not.toHaveBeenCalled();
    expect(opsAt("error")).toContain("approval_mode_not_applied");
    expect(opsAt("warn")).not.toContain("approval_mode_unsupported_by_agent");
    expect(sm.getSession("old-m2")?.approvalModeNotApplied).toBe("auto");
    expect(history.some((m) => m.id === "note_approval_mode_old-m2_auto")).toBe(true);
  });

  it("Auto on a resumed Codex chat whose known set has neither `agent` nor `auto`: error line and notice", async () => {
    setMode("auto");
    const { sm } = createHarness({
      agentId: "codex",
      pastSessions: ["old-m2c"],
      loadResult: { modes: { currentModeId: "read-only", availableModes: [{ id: "read-only" }] } },
    });
    await sm.loadInitialSessions("codex");

    await sm.activateSession("old-m2c");

    expect(opsAt("error")).toContain("approval_mode_not_applied");
    expect(sm.getSession("old-m2c")?.approvalModeNotApplied).toBe("auto");
  });

  it("Auto, no extension prompts with a known set lacking every candidate stays the quiet degrade: warn, no error, no notice", async () => {
    setMode("auto-with-generations");
    const { sm, events } = createHarness({
      agentId: "codex",
      pastSessions: ["old-q2"],
      loadResult: {
        modes: { currentModeId: "agent", availableModes: [{ id: "read-only" }, { id: "agent" }] },
      },
    });
    await sm.loadInitialSessions("codex");

    const history = await sm.activateSession("old-q2");

    expect(opsAt("warn")).toContain("approval_mode_unsupported_by_agent");
    expect(opsAt("error")).not.toContain("approval_mode_not_applied");
    expect(sm.getSession("old-q2")?.approvalModeNotApplied).toBeUndefined();
    expect(history.some((m) => m.id.startsWith("note_approval_mode_"))).toBe(false);
    expect(events.some((e) => e.event.type === "chat-note")).toBe(false);
  });

  it("Auto, no extension prompts on a root Claude (no `bypassPermissions` advertised) falls back to `default`", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-root"],
      loadResult: {
        modes: {
          currentModeId: "plan",
          availableModes: CLAUDE_MODES.filter((m) => m.id !== "bypassPermissions"),
        },
      },
    });
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-root");

    // Not left in the user's own `permissions.defaultMode` (here `plan`): `default` routes every
    // tool call to libi, which auto-allows all of them under this mode.
    expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: "old-root", modeId: "default" });
    expect(opsAt("error")).not.toContain("approval_mode_not_applied");
  });
});

/** Resolve after every queued microtask and a macrotask turn. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("a prompt to a resumed chat waits for its mode push (review M3)", () => {
  it("`session/prompt` goes out only after the in-flight `set_mode` settles, even though the chat already reads active", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-w"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    let releaseSetMode!: () => void;
    conn.setSessionMode.mockImplementationOnce(
      () => new Promise<void>((r) => (releaseSetMode = () => r())),
    );
    await sm.loadInitialSessions("claude-code");

    const activation = sm.activateSession("old-w");
    await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalled());
    // The send route's only check: the chat already reads active while `set_mode` is in flight.
    expect(sm.hasActiveSession("old-w")).toBe(true);

    const sent = sm.sendMessage("old-w", "rename this piece");
    await flush();
    expect(conn.prompt).not.toHaveBeenCalled();

    releaseSetMode();
    await activation;
    await sent;

    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(conn.setSessionMode.mock.invocationCallOrder[0]).toBeLessThan(
      conn.prompt.mock.invocationCallOrder[0],
    );
  });

  it("a push that FAILS while the prompt waits reports first, and holds the prompt", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-f"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    let failSetMode!: () => void;
    conn.setSessionMode.mockImplementationOnce(
      () => new Promise<void>((_, rej) => (failSetMode = () => rej(new Error("refused")))),
    );
    await sm.loadInitialSessions("claude-code");

    const activation = sm.activateSession("old-f");
    await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalled());
    const sent = sm.sendMessage("old-f", "rename this piece");
    await flush();
    expect(conn.prompt).not.toHaveBeenCalled();

    failSetMode();
    await activation;
    await sent;

    // The failure reported itself, and — Ask being held on a failed push — nothing was sent.
    const cache = sm.getSession("old-f")!.messageCache;
    expect(cache.some((m) => m.id === "note_approval_mode_old-f_ask")).toBe(true);
    expect(cache.some((m) => m.role === "user")).toBe(false);
    expect(conn.prompt).not.toHaveBeenCalled();
  });

  it.each<ApprovalMode>(["ask", "auto"])(
    "%s: a `set_mode` that never answers within the bound — the prompt is NOT sent; error line, note, and a failed send",
    async (mode) => {
      setMode(mode);
      const { sm, conn, events } = createHarness({
        agentId: "claude-code",
        pastSessions: ["old-h"],
        loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
      });
      conn.setSessionMode.mockImplementationOnce(() => new Promise<void>(() => {}));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sm as any).approvalModePushWaitMs = 20;
      await sm.loadInitialSessions("claude-code");

      void sm.activateSession("old-h");
      await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalled());

      // The send route's gate: answers not-ok, so the route can fail the send (Retry).
      await expect(sm.awaitApprovalMode("old-h")).resolves.toEqual({
        ok: false,
        mode,
        retryable: true,
        error: expect.stringContaining("so the message wasn't sent"),
      });
      // sendMessage holds the same line for callers that skip the route.
      await sm.sendMessage("old-h", "hello");

      expect(conn.prompt).not.toHaveBeenCalled();
      const errorCall = vi
        .mocked(serverLogger.error)
        .mock.calls.find((c) => (c[0] as { op?: string }).op === "approval_mode_not_applied");
      expect(errorCall?.[0]).toMatchObject({ mode, reason: "set_timeout", sessionId: "old-h" });
      const cache = sm.getSession("old-h")!.messageCache;
      const timeoutNote = cache.find((m) => m.id === `note_approval_mode_old-h_${mode}`);
      // While the push hangs, sending again only waits again — Restart session is the real way out.
      expect(JSON.stringify(timeoutNote?.parts)).toContain("Restart session");
      expect(cache.some((m) => m.role === "user")).toBe(false);
      expect(events).toContainEqual({
        sessionId: "old-h",
        event: expect.objectContaining({ type: "agent-status", status: "error" }),
      });
    },
  );

  it("Auto, no extension prompts: past the bound the prompt still goes out (nothing is more permissive), warned once", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-g"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    conn.setSessionMode.mockImplementationOnce(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions("claude-code");

    void sm.activateSession("old-g");
    await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalled());

    // The route's gate, then the send: the second does not sit out the bound again.
    await expect(sm.awaitApprovalMode("old-g")).resolves.toEqual({ ok: true });
    await sm.sendMessage("old-g", "hello");

    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(opsAt("warn").filter((op) => op === "approval_mode_push_wait_timeout")).toHaveLength(1);
    expect(opsAt("error")).not.toContain("approval_mode_not_applied");
  });

  it("a push that REPLACES the awaited one (picker changed mid-wait) is followed: the prompt waits for the newer push too", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-p"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    let releaseResume!: () => void;
    let releaseChange!: () => void;
    conn.setSessionMode
      .mockImplementationOnce(() => new Promise<void>((r) => (releaseResume = () => r())))
      .mockImplementationOnce(() => new Promise<void>((r) => (releaseChange = () => r())));
    await sm.loadInitialSessions("claude-code");

    const activation = sm.activateSession("old-p");
    await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalledTimes(1));
    const sent = sm.sendMessage("old-p", "hello");
    setMode("auto");
    const change = sm.applyApprovalModeToActiveSessions("claude-code");
    await vi.waitFor(() => expect(conn.setSessionMode).toHaveBeenCalledTimes(2));

    releaseResume();
    await activation;
    await flush();
    expect(conn.prompt).not.toHaveBeenCalled();

    releaseChange();
    await change;
    await sent;
    expect(conn.prompt).toHaveBeenCalledTimes(1);
  });

  it("a send with no push in flight is not delayed", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-n"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-n");

    await sm.sendMessage("old-n", "hello");

    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(opsAt("warn")).not.toContain("approval_mode_push_wait_timeout");
    await expect(sm.awaitApprovalMode("old-n")).resolves.toEqual({ ok: true });
  });
});

describe("a notice posted mid-turn (review M4)", () => {
  it("lands BEFORE the streaming reply, so a history refetch still adopts the reply as the live message", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-t"],
      loadResult: { modes: { currentModeId: "read-only", availableModes: CODEX_MODES } },
    });
    await sm.loadInitialSessions("codex");
    await sm.activateSession("old-t");
    let endTurn!: () => void;
    conn.prompt.mockImplementationOnce(
      () => new Promise((r) => (endTurn = () => r({ stopReason: "end_turn" }))),
    );
    const sent = sm.sendMessage("old-t", "go");
    await vi.waitFor(() => expect(conn.prompt).toHaveBeenCalled());

    // The user flips the picker mid-turn, and the adapter refuses.
    setMode("auto");
    conn.setSessionMode.mockRejectedValueOnce(new Error("refused"));
    await sm.applyApprovalModeToActiveSessions("codex");

    const entry = sm.getSession("old-t")!;
    const cache = entry.messageCache;
    expect(cache[cache.length - 1]).toBe(entry.currentAgentMessage);
    expect(cache.some((m) => m.id === "note_approval_mode_old-t_auto")).toBe(true);

    endTurn();
    await sent;
  });
});

describe("a blind Claude push tries every candidate (re-review R-m1)", () => {
  it("Auto, no extension prompts with nothing known on a root Claude: `bypassPermissions` refused → `default` pushed, no error", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-rb"] });
    conn.setSessionMode.mockRejectedValueOnce(new Error("Mode bypassPermissions is not available"));
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-rb");

    expect(conn.setSessionMode.mock.calls.map((c) => c[0].modeId)).toEqual([
      "bypassPermissions",
      "default",
    ]);
    expect(opsAt("error")).not.toContain("approval_mode_not_applied");
    expect(sm.getSession("old-rb")?.approvalModeNotApplied).toBeUndefined();
  });

  it("every candidate refused: one error line and the notice", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-rr"] });
    conn.setSessionMode.mockRejectedValue(new Error("refused"));
    await sm.loadInitialSessions("claude-code");

    await sm.activateSession("old-rr");

    expect(conn.setSessionMode).toHaveBeenCalledTimes(2);
    expect(opsAt("error").filter((op) => op === "approval_mode_not_applied")).toHaveLength(1);
    expect(sm.getSession("old-rr")?.approvalModeNotApplied).toBe("auto-with-generations");
  });
});

describe("a FAILED push holds prompts too, for Ask and Auto (controller decision after e2aeeb37)", () => {
  it.each<ApprovalMode>(["ask", "auto"])(
    "%s: the adapter refuses the resume push — the gate re-attempts it, and while it keeps failing nothing is sent",
    async (mode) => {
      setMode(mode);
      const { sm, conn } = createHarness({
        agentId: "claude-code",
        pastSessions: ["old-x1"],
        loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
      });
      conn.setSessionMode.mockRejectedValue(new Error("refused"));
      await sm.loadInitialSessions("claude-code");
      await sm.activateSession("old-x1");
      expect(conn.setSessionMode).toHaveBeenCalledTimes(1);

      const gate = await sm.awaitApprovalMode("old-x1");
      // Retry is a real re-attempt, not a dead end.
      expect(conn.setSessionMode).toHaveBeenCalledTimes(2);
      expect(gate).toEqual({
        ok: false,
        mode,
        retryable: true,
        error: expect.stringContaining("so the message wasn't sent"),
      });

      await sm.sendMessage("old-x1", "hello");
      expect(conn.prompt).not.toHaveBeenCalled();
      expect(sm.getSession("old-x1")!.messageCache.some((m) => m.role === "user")).toBe(false);
      const note = sm
        .getSession("old-x1")!
        .messageCache.find((m) => m.id === `note_approval_mode_old-x1_${mode}`);
      expect(JSON.stringify(note?.parts)).toContain("send again to retry");
    },
  );

  it("Retry after the adapter recovers: the re-attempted push lands, the state clears, and the prompt goes out", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-x2"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    conn.setSessionMode
      .mockRejectedValueOnce(new Error("refused")) // resume
      .mockRejectedValueOnce(new Error("refused")); // first send's re-attempt
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-x2");

    expect((await sm.awaitApprovalMode("old-x2")).ok).toBe(false);
    // The user presses Retry: the next re-attempt lands.
    await expect(sm.awaitApprovalMode("old-x2")).resolves.toEqual({ ok: true });
    expect(sm.getSession("old-x2")?.approvalModeNotApplied).toBeUndefined();

    await sm.sendMessage("old-x2", "hello");
    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(conn.setSessionMode).toHaveBeenCalledTimes(3);
  });

  it("a later successful picker-change push clears the state: the next send goes straight through, no re-attempt", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-x3"],
      loadResult: undefined,
    });
    await sm.loadInitialSessions("codex");
    await sm.activateSession("old-x3");
    expect((await sm.awaitApprovalMode("old-x3")).ok).toBe(false); // modes_unknown: still nothing known

    conn.newSession.mockResolvedValueOnce({
      sessionId: "standby-x",
      modes: { currentModeId: "agent", availableModes: CODEX_MODES },
    });
    await sm.createStandbySession();
    setMode("auto");
    await sm.applyApprovalModeToActiveSessions("codex");
    conn.setSessionMode.mockClear();

    await expect(sm.awaitApprovalMode("old-x3")).resolves.toEqual({ ok: true });
    expect(conn.setSessionMode).not.toHaveBeenCalled();
    await sm.sendMessage("old-x3", "hello");
    expect(conn.prompt).toHaveBeenCalledTimes(1);
  });

  it("a mode the agent doesn't offer is held with a non-retryable reason that names the way out", async () => {
    setMode("auto");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-x4"],
      loadResult: {
        modes: { currentModeId: "plan", availableModes: [{ id: "acceptEdits" }, { id: "plan" }] },
      },
    });
    await sm.loadInitialSessions("claude-code");
    const history = await sm.activateSession("old-x4");

    const gate = await sm.awaitApprovalMode("old-x4");
    expect(gate).toEqual({
      ok: false,
      mode: "auto",
      retryable: false,
      error: expect.stringContaining("pick another approval mode"),
    });
    expect(conn.setSessionMode).not.toHaveBeenCalled();
    const note = history.find((m) => m.id === "note_approval_mode_old-x4_auto");
    expect(JSON.stringify(note?.parts)).toContain("pick another approval mode");
  });

  it("Auto, no extension prompts whose push failed still sends (nothing is more permissive)", async () => {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: ["old-x5"] });
    conn.setSessionMode.mockRejectedValue(new Error("refused"));
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-x5");
    expect(sm.getSession("old-x5")?.approvalModeNotApplied).toBe("auto-with-generations");
    const pushesBefore = conn.setSessionMode.mock.calls.length;

    await expect(sm.awaitApprovalMode("old-x5")).resolves.toEqual({ ok: true });
    await sm.sendMessage("old-x5", "hello");

    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(conn.setSessionMode.mock.calls.length).toBe(pushesBefore);
  });

  it("fail → land → fail again: an 'applied' note follows the first failure, and the second failure posts a fresh note", async () => {
    setMode("ask");
    const { sm, conn, events } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-x6"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    conn.setSessionMode.mockRejectedValueOnce(new Error("refused")); // resume
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-x6");
    const noteIds = () => sm.getSession("old-x6")!.messageCache.map((m) => m.id);
    expect(noteIds()).toEqual(["note_approval_mode_old-x6_ask"]);

    // Retry lands: the chat is told the mode is now in force.
    await expect(sm.awaitApprovalMode("old-x6")).resolves.toEqual({ ok: true });
    expect(noteIds()).toEqual([
      "note_approval_mode_old-x6_ask",
      "note_approval_mode_applied_old-x6_1",
    ]);
    const applied = sm.getSession("old-x6")!.messageCache[1];
    expect(JSON.stringify(applied.parts)).toContain("'Ask each time' is now applied to this chat.");

    // It fails again: a fresh note, not swallowed by the first one's id.
    conn.setSessionMode.mockRejectedValueOnce(new Error("refused"));
    await sm.applyApprovalModeToActiveSessions("claude-code");
    expect(noteIds()).toEqual([
      "note_approval_mode_old-x6_ask",
      "note_approval_mode_applied_old-x6_1",
      "note_approval_mode_old-x6_ask_1",
    ]);
    const liveNotes = events
      .filter((e) => e.sessionId === "old-x6" && e.event.type === "chat-note")
      .map((e) => (e.event as { noteId?: string }).noteId);
    expect(liveNotes).toEqual([
      "note_approval_mode_old-x6_ask",
      "note_approval_mode_applied_old-x6_1",
      "note_approval_mode_old-x6_ask_1",
    ]);
  });

  it("a push that lands with nothing failed before posts no 'applied' note", async () => {
    setMode("ask");
    const { sm } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-x7"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-x7");
    await sm.applyApprovalModeToActiveSessions("claude-code");
    expect(sm.getSession("old-x7")!.messageCache).toEqual([]);
  });
});

describe("a push that never answers can't hang activation or a new chat (re-review R2-m1)", () => {
  it("resume: activation returns after the bound; the prompt gate still holds the send", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-hang"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    conn.setSessionMode.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions("claude-code");

    await expect(sm.activateSession("old-hang")).resolves.toBeDefined();
    expect(sm.hasActiveSession("old-hang")).toBe(true);
    expect(opsAt("warn")).toContain("approval_mode_push_slow");

    expect((await sm.awaitApprovalMode("old-hang")).ok).toBe(false);
    await sm.sendMessage("old-hang", "hello");
    expect(conn.prompt).not.toHaveBeenCalled();
  });

  it("new chat: createSession returns after the bound", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: [],
      newSessionResult: {
        sessionId: "fresh-hang",
        modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
      },
    });
    conn.setSessionMode.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions("claude-code");

    await expect(sm.createSession()).resolves.toBe("fresh-hang");
    expect((await sm.awaitApprovalMode("fresh-hang")).ok).toBe(false);
  });

  it("picker change: applyApprovalModeToActiveSessions returns after the bound; the gate still holds the send", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-pick"],
      loadResult: { modes: { currentModeId: "auto", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-pick");
    conn.setSessionMode.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;

    await expect(sm.applyApprovalModeToActiveSessions("claude-code")).resolves.toBeUndefined();
    expect(opsAt("warn")).toContain("approval_mode_push_slow");

    expect((await sm.awaitApprovalMode("old-pick")).ok).toBe(false);
    await sm.sendMessage("old-pick", "hello");
    expect(conn.prompt).not.toHaveBeenCalled();
  });

  it("a standby whose set_mode never answers is still created, and standbyCreating clears", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: [],
      newSessionResult: {
        sessionId: "standby-hang",
        modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
      },
    });
    await sm.loadInitialSessions("claude-code");
    conn.setSessionMode.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;

    await expect(sm.createStandbySession()).resolves.toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sm as any).standbyCreating).toBe(false);
    expect(sm.isStandbyReady()).toBe(true);
    expect(opsAt("warn")).toContain("approval_mode_push_slow");
  });

  it("a standby whose model push never answers is still created, and standbyCreating clears", async () => {
    setMode("ask");
    vi.mocked(getAgentModelId).mockReturnValue("opus");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: [],
      newSessionResult: {
        sessionId: "standby-model-hang",
        modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "sonnet",
            options: [
              { value: "sonnet", name: "Sonnet" },
              { value: "opus", name: "Opus" },
            ],
          },
        ],
      },
    });
    await sm.loadInitialSessions("claude-code");
    conn.setSessionConfigOption.mockImplementation(() => new Promise<void>(() => {}));
    conn.unstable_setSessionModel.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;

    try {
      await expect(sm.createStandbySession()).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((sm as any).standbyCreating).toBe(false);
      expect(conn.setSessionConfigOption).toHaveBeenCalled();
      expect(opsAt("warn")).toContain("push_model_slow");
    } finally {
      vi.mocked(getAgentModelId).mockReturnValue(null);
    }
  });
});

describe("the Codex note doesn't promise the extension gate (re-review R-m3)", () => {
  it("Codex Auto not applied: no 'requires approval … ask first' promise", async () => {
    setMode("auto");
    const { sm } = createHarness({
      agentId: "codex",
      pastSessions: ["old-cx"],
      loadResult: { modes: { currentModeId: "read-only", availableModes: [{ id: "read-only" }] } },
    });
    await sm.loadInitialSessions("codex");
    const history = await sm.activateSession("old-cx");

    const note = history.find((m) => m.id === "note_approval_mode_old-cx_auto");
    expect(note).toBeDefined();
    expect(JSON.stringify(note?.parts)).not.toContain("requires approval");
  });
});

/**
 * A fake adapter whose `set_mode` calls resolve when the test says, in any order; the mode it
 * ends in is the one whose call resolved LAST — what a real adapter would be left in.
 */
function outOfOrderSetMode(conn: { setSessionMode: ReturnType<typeof vi.fn> }) {
  const pending: Array<{ modeId: string; sessionId: string; settle: (ok: boolean) => void }> = [];
  const adapter = { mode: null as string | null };
  conn.setSessionMode.mockImplementation(
    ({ modeId, sessionId }: { modeId: string; sessionId: string }) =>
      new Promise<void>((resolve, reject) => {
        pending.push({
          modeId,
          sessionId,
          settle: (ok) => {
            if (ok) {
              adapter.mode = modeId;
              resolve();
            } else reject(new Error("refused"));
          },
        });
      }),
  );
  return { pending, adapter };
}

describe("an older push that lands last can't leave the chat more permissive (re-review R3-m1)", () => {
  it("Codex: an Auto retry that lands AFTER the switch to Ask — the chat ends in read-only, not agent", async () => {
    setMode("auto");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-ooo"],
      loadResult: { modes: { currentModeId: "agent", availableModes: CODEX_MODES } },
    });
    const { pending, adapter } = outOfOrderSetMode(conn);
    await sm.loadInitialSessions("codex");
    const activation = sm.activateSession("old-ooo");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].settle(false); // the resume push is refused → held
    await activation;
    expect(sm.getSession("old-ooo")?.approvalModeNotApplied).toBe("auto");

    // Send → the gate's retry push of `agent` (A) is in flight…
    const gate = sm.awaitApprovalMode("old-ooo");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // …and the user switches to Ask: push of `read-only` (B).
    setMode("ask");
    const change = sm.applyApprovalModeToActiveSessions("codex");
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(pending.map((p) => p.modeId)).toEqual(["agent", "agent", "read-only"]);

    // B lands first, then the stale A.
    pending[2].settle(true);
    await change;
    pending[1].settle(true);
    // Whatever the guard re-pushes lands too.
    await vi.waitFor(() => {
      for (const p of pending.slice(3)) p.settle(true);
      expect(adapter.mode).toBe("read-only");
    });
    await gate;

    expect(adapter.mode).toBe("read-only");
    expect(pending[pending.length - 1].modeId).toBe("read-only");
  });

  it.each([
    { agentId: "claude-code" as const, modes: CLAUDE_MODES, stale: "bypassPermissions", safe: "default" },
    { agentId: "codex" as const, modes: CODEX_MODES, stale: "agent-full-access", safe: "read-only" },
  ])(
    "$agentId: a standby's hung push that lands AFTER the claim's push is followed by the current mode, and the gate waits for it",
    async ({ agentId, modes, stale, safe }) => {
      setMode("auto-with-generations");
      const { sm, conn } = createHarness({ agentId, pastSessions: [] });
      const advertised = { currentModeId: modes[0].id, availableModes: modes };
      conn.newSession
        .mockResolvedValueOnce({ sessionId: "standby-ooo", modes: advertised })
        .mockResolvedValue({ sessionId: "standby-next", modes: advertised });
      const { pending: all, adapter } = outOfOrderSetMode(conn);
      // The chat's own pushes; the replenished standby's are another session's.
      const pending = { get: () => all.filter((p) => p.sessionId === "standby-ooo") };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sm as any).approvalModePushWaitMs = 20;
      await sm.loadInitialSessions(agentId);
      await sm.createStandbySession(); // its push (the never-prompt mode) hangs past the bound
      expect(pending.get().map((p) => p.modeId)).toEqual([stale]);
      expect(sm.isStandbyReady()).toBe(true);

      // The user switches to Ask, then opens a new chat: the claim pushes the safe mode.
      setMode("ask");
      const id = await sm.createSession();
      expect(id).toBe("standby-ooo");
      expect(pending.get().map((p) => p.modeId)).toEqual([stale, safe]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sm as any).approvalModePushWaitMs = 4_000; // the gate below waits; nothing here hangs

      // The claim's push lands first; then the standby's stale one lands over it.
      pending.get()[1].settle(true);
      await Promise.resolve();
      const gate = sm.awaitApprovalMode(id);
      pending.get()[0].settle(true);
      expect(adapter.mode).toBe(stale);
      // libi pushes the current mode again, and the gate waits for it.
      await vi.waitFor(() => expect(pending.get().length).toBeGreaterThan(2));
      expect(pending.get()[pending.get().length - 1].modeId).toBe(safe);
      for (const p of pending.get().slice(2)) p.settle(true);
      await expect(gate).resolves.toEqual({ ok: true });
      expect(adapter.mode).toBe(safe);
    },
  );

  it("a push that lands after the saved mode moved on (no newer push) doesn't clear the state, and the current mode is pushed", async () => {
    setMode("auto");
    const { sm, conn } = createHarness({
      agentId: "codex",
      pastSessions: ["old-mv"],
      loadResult: { modes: { currentModeId: "agent", availableModes: CODEX_MODES } },
    });
    const { pending, adapter } = outOfOrderSetMode(conn);
    await sm.loadInitialSessions("codex");
    const activation = sm.activateSession("old-mv");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The saved mode moves on while `agent` is in flight, with no push of its own.
    setMode("ask");
    pending[0].settle(true);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].modeId).toBe("read-only");
    pending[1].settle(true);
    await activation;

    expect(adapter.mode).toBe("read-only");
    await expect(sm.awaitApprovalMode("old-mv")).resolves.toEqual({ ok: true });
  });
});

describe("Codex with no known modes is not retryable (re-review R3-m2)", () => {
  it("the gate says so, and names a new chat as the way out", async () => {
    setMode("ask");
    const { sm } = createHarness({ agentId: "codex", pastSessions: ["old-mu"], loadResult: undefined });
    await sm.loadInitialSessions("codex");
    await sm.activateSession("old-mu");

    await expect(sm.awaitApprovalMode("old-mu")).resolves.toEqual({
      ok: false,
      mode: "ask",
      retryable: false,
      error: expect.stringContaining("start a new chat"),
    });
  });
});

describe("a model push that never answers can't hang activation (re-review R3-m3)", () => {
  it("activation returns after the bound, warned", async () => {
    setMode("ask");
    vi.mocked(getAgentModelId).mockReturnValue("m2");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-mdl"],
      loadResult: {
        modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
        configOptions: [
          {
            id: "model",
            type: "select",
            name: "Model",
            currentValue: "m1",
            options: [
              { value: "m1", name: "M1" },
              { value: "m2", name: "M2" },
            ],
          },
        ],
      } as LoadResult,
    });
    conn.setSessionConfigOption.mockImplementation(() => new Promise<void>(() => {}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions("claude-code");

    await expect(sm.activateSession("old-mdl")).resolves.toBeDefined();
    expect(conn.setSessionConfigOption).toHaveBeenCalled();
    expect(opsAt("warn")).toContain("push_model_slow");
    vi.mocked(getAgentModelId).mockReturnValue(null);
  });
});

describe("a waived push stays in the chain (NQ-7 review)", () => {
  const CASES = [
    { agentId: "claude-code" as const, modes: CLAUDE_MODES, loose: "bypassPermissions", safe: "default" },
    { agentId: "codex" as const, modes: CODEX_MODES, loose: "agent-full-access", safe: "read-only" },
  ];

  async function waivedLoosePush(agentId: "claude-code" | "codex", modes: { id: string }[]) {
    setMode("auto-with-generations");
    const { sm, conn } = createHarness({
      agentId,
      pastSessions: ["old-w"],
      loadResult: { modes: { currentModeId: modes[0].id, availableModes: modes } },
    });
    const { pending, adapter } = outOfOrderSetMode(conn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions(agentId);
    await sm.activateSession("old-w"); // push W (the never-prompt mode) hangs past the bound
    // The never-prompt gate waives W and lets a prompt through — nothing is more permissive.
    await expect(sm.awaitApprovalMode("old-w")).resolves.toEqual({ ok: true });
    expect(opsAt("warn")).toContain("approval_mode_push_wait_timeout");
    return { sm, conn, pending, adapter };
  }

  it.each(CASES)(
    "$agentId: W waived → picker to Ask → P lands → the gate still waits for W, and W landing late is followed by Ask",
    async ({ agentId, modes, loose, safe }) => {
      const { sm, pending, adapter } = await waivedLoosePush(agentId, modes);
      setMode("ask");
      await sm.applyApprovalModeToActiveSessions(agentId); // push P, bounded
      expect(pending.map((p) => p.modeId)).toEqual([loose, safe]);
      pending[1].settle(true); // P lands

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sm as any).approvalModePushWaitMs = 4_000;
      let passed = false;
      const gate = sm.awaitApprovalMode("old-w").then((g) => {
        passed = true;
        return g;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(passed).toBe(false); // W, the looser push, is still outstanding

      pending[0].settle(true); // W lands late: the adapter is in the looser mode…
      expect(adapter.mode).toBe(loose);
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(2)); // …so Ask is pushed again
      expect(pending[pending.length - 1].modeId).toBe(safe);
      for (const p of pending.slice(2)) p.settle(true);
      await expect(gate).resolves.toEqual({ ok: true });
      expect(adapter.mode).toBe(safe);
    },
  );

  it.each(CASES)(
    "$agentId: W never answers → under Ask the gate holds, it never sends",
    async ({ agentId, modes, safe }) => {
      const { sm, conn, pending } = await waivedLoosePush(agentId, modes);
      setMode("ask");
      await sm.applyApprovalModeToActiveSessions(agentId);
      pending[1].settle(true);
      expect(pending[1].modeId).toBe(safe);

      const gate = await sm.awaitApprovalMode("old-w");
      expect(gate).toMatchObject({ ok: false, mode: "ask", retryable: true });
      await sm.sendMessage("old-w", "hello");
      expect(conn.prompt).not.toHaveBeenCalled();
    },
  );
});

describe("a standby model push that lands after the claim (NQ-7 review)", () => {
  it("the current model preference is pushed again — latest intent wins", async () => {
    setMode("ask");
    vi.mocked(getAgentModelId).mockReturnValue("m2");
    const { sm, conn } = createHarness({ agentId: "claude-code", pastSessions: [] });
    const configOptions = [
      {
        id: "model",
        type: "select",
        name: "Model",
        currentValue: "m1",
        options: [
          { value: "m1", name: "M1" },
          { value: "m2", name: "M2" },
          { value: "m3", name: "M3" },
        ],
      },
    ];
    conn.newSession
      .mockResolvedValueOnce({ sessionId: "standby-mdl", configOptions })
      .mockResolvedValue({ sessionId: "standby-mdl-next", configOptions });
    const calls: Array<{ sessionId: string; value: string; settle: () => void }> = [];
    conn.setSessionConfigOption.mockImplementation(
      ({ sessionId, value }: { sessionId: string; value: string }) =>
        new Promise<void>((resolve) => calls.push({ sessionId, value, settle: resolve })),
    );
    const mine = () => calls.filter((c) => c.sessionId === "standby-mdl");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    try {
      await sm.loadInitialSessions("claude-code");
      await sm.createStandbySession(); // pushes m2; it hangs past the bound
      expect(mine().map((c) => c.value)).toEqual(["m2"]);

      vi.mocked(getAgentModelId).mockReturnValue("m3");
      const id = await sm.createSession();
      expect(mine().map((c) => c.value)).toEqual(["m2", "m3"]);
      mine()[1].settle(); // the claim's m3 lands
      await Promise.resolve();
      mine()[0].settle(); // then the standby's stale m2
      await vi.waitFor(() => expect(mine().length).toBeGreaterThan(2));
      expect(mine()[mine().length - 1].value).toBe("m3");
      for (const c of mine().slice(2)) c.settle();
      await vi.waitFor(() =>
        expect(sm.getSessionModelState(id)?.currentModelId).toBe("m3"),
      );
    } finally {
      vi.mocked(getAgentModelId).mockReturnValue(null);
    }
  });
});

describe("a push with no connection is a not-applied state (NQ-7 review)", () => {
  it("logged, noted and held under Auto; a later push that lands clears it", async () => {
    setMode("ask");
    const { sm, conn, pm } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-nc"],
      loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-nc");

    pm.getConnection.mockReturnValue(undefined);
    setMode("auto");
    await sm.applyApprovalModeToActiveSessions("claude-code");
    expect(
      vi.mocked(serverLogger.debug).mock.calls.map((c) => (c[0] as { op?: string })?.op),
    ).toContain("approval_mode_no_connection");
    expect(sm.getSession("old-nc")?.approvalModeNotApplied).toBe("auto");
    expect(sm.getSession("old-nc")!.messageCache.map((m) => m.id)).toEqual([
      "note_approval_mode_old-nc_auto",
    ]);
    expect((await sm.awaitApprovalMode("old-nc")).ok).toBe(false);

    pm.getConnection.mockReturnValue(conn);
    await expect(sm.awaitApprovalMode("old-nc")).resolves.toEqual({ ok: true });
    expect(sm.getSession("old-nc")?.approvalModeNotApplied).toBeUndefined();
  });
});

describe("Restart is a way out of a set_mode that never answers (NQ-7 re-review a)", () => {
  it.each([
    { killRejects: true, label: "the kill rejects the stuck push" },
    { killRejects: false, label: "the stuck push never settles at all" },
  ])(
    "close and load answer but set_mode hangs: Restart replaces the process and the chat sends under Ask ($label)",
    async ({ killRejects }) => {
      setMode("ask");
      const { sm, conn, pm } = createHarness({
        agentId: "claude-code",
        pastSessions: ["old-rs"],
        loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
      });
      const stuck: Array<(e: Error) => void> = [];
      conn.setSessionMode.mockImplementation(
        () => new Promise<void>((_resolve, reject) => stuck.push(reject)),
      );
      const restartProcess = vi.fn(async () => {
        if (killRejects) for (const r of stuck) r(new Error("ACP connection closed"));
        conn.setSessionMode.mockImplementation(async () => {});
      });
      (pm as unknown as { restartProcess: typeof restartProcess }).restartProcess = restartProcess;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sm as any).approvalModePushWaitMs = 20;
      await sm.loadInitialSessions("claude-code");
      await sm.activateSession("old-rs");
      expect((await sm.awaitApprovalMode("old-rs")).ok).toBe(false); // held: set_timeout

      await expect(sm.restartSession("old-rs")).resolves.toEqual({
        agentId: "claude-code",
        processRestarted: true,
      });
      expect(restartProcess).toHaveBeenCalledWith("claude-code");
      await expect(sm.awaitApprovalMode("old-rs")).resolves.toEqual({ ok: true });
      await sm.sendMessage("old-rs", "hello");
      expect(conn.prompt).toHaveBeenCalledTimes(1);
    },
  );

  it("another chat on the process is working: the process is kept and the failure says why", async () => {
    setMode("ask");
    const { sm, conn, pm } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-rb", "old-busy"],
      loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
    });
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-busy");
    conn.prompt.mockImplementation(() => new Promise(() => {}));
    void sm.sendMessage("old-busy", "long job"); // a turn that runs on
    await vi.waitFor(() => expect(conn.prompt).toHaveBeenCalled());
    conn.setSessionMode.mockImplementation(() => new Promise<void>(() => {}));
    const restartProcess = vi.fn(async () => {});
    (pm as unknown as { restartProcess: typeof restartProcess }).restartProcess = restartProcess;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.activateSession("old-rb");

    await expect(sm.restartSession("old-rb")).rejects.toMatchObject({ code: "agent_busy" });
    expect(restartProcess).not.toHaveBeenCalled();
  });
});

describe("a chat the user sent in is never an untouched chat (NQ-7 re-review c)", () => {
  it("sendMessage marks it, even when the gate holds the message", async () => {
    setMode("ask");
    const { sm, conn } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-us"],
      loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
    });
    conn.setSessionMode.mockRejectedValue(new Error("refused"));
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-us");
    expect(sm.getSession("old-us")?.userSent).toBeFalsy();
    await sm.sendMessage("old-us", "hello");
    expect(conn.prompt).not.toHaveBeenCalled();
    expect(sm.getSession("old-us")?.userSent).toBe(true);
  });
});

describe("Restart replacing the process for a stuck push (NQ-7 re-review 2)", () => {
  /** A resumed Ask chat whose resume push never answers, and never settles even on a kill. */
  async function heldByStuckPush(sessionIds: string[] = ["old-ra"]) {
    setMode("ask");
    const { sm, conn, pm } = createHarness({
      agentId: "claude-code",
      pastSessions: sessionIds,
      loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
    });
    const proc = { replaced: false };
    const loadsOnNewProcess: string[] = [];
    conn.loadSession.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (proc.replaced) loadsOnNewProcess.push(sessionId);
      return { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } };
    });
    let first = true;
    conn.setSessionMode.mockImplementation(() => {
      if (first) {
        first = false;
        return new Promise<void>(() => {}); // W: stuck for good
      }
      return Promise.resolve();
    });
    const restartProcess = vi.fn(async () => {
      proc.replaced = true;
    });
    (pm as unknown as { restartProcess: typeof restartProcess }).restartProcess = restartProcess;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 100;
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession(sessionIds[0]);
    expect((await sm.awaitApprovalMode(sessionIds[0])).ok).toBe(false);
    return { sm, conn, pm, proc, loadsOnNewProcess, restartProcess };
  }

  it("an activation that lands on the OLD process during the stuck-push wait is released: the chat loads on the new one", async () => {
    const { sm, conn, loadsOnNewProcess } = await heldByStuckPush();
    // Right after the restart's close, something (a history GET, a send) activates the chat again —
    // on the old process, inside the restart's stuck-push wait.
    conn.closeSession.mockImplementation(async () => {
      setTimeout(() => void sm.activateSession("old-ra").catch(() => {}), 5);
    });

    await expect(sm.restartSession("old-ra")).resolves.toMatchObject({ processRestarted: true });
    expect(loadsOnNewProcess).toContain("old-ra");
    await expect(sm.awaitApprovalMode("old-ra")).resolves.toEqual({ ok: true });
  });

  it("restartProcess throwing still forgets the old process's pushes", async () => {
    const { sm, restartProcess } = await heldByStuckPush();
    restartProcess.mockRejectedValue(new Error("spawn failed"));
    await expect(sm.restartSession("old-ra")).rejects.toMatchObject({ code: "agent_unresponsive" });
    expect(sm.getSession("old-ra")?.approvalModePush).toBeUndefined();
  });

  it("a crash forgets the crashed process's pushes", async () => {
    const { sm } = await heldByStuckPush();
    expect(sm.getSession("old-ra")?.approvalModePush).toBeDefined();
    sm.handleProcessCrash("claude-code", "boom");
    expect(sm.getSession("old-ra")?.approvalModePush).toBeUndefined();
  });

  it("an old push landing late on a chat that isn't loaded any more pushes nothing and notes nothing", async () => {
    setMode("ask");
    const { sm, conn, pm } = createHarness({
      agentId: "claude-code",
      pastSessions: ["old-idle", "old-rr"],
      loadResult: { modes: { currentModeId: "default", availableModes: CLAUDE_MODES } },
    });
    const { pending } = outOfOrderSetMode(conn);
    const restartProcess = vi.fn(async () => {});
    (pm as unknown as { restartProcess: typeof restartProcess }).restartProcess = restartProcess;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).approvalModePushWaitMs = 20;
    await sm.loadInitialSessions("claude-code");
    await sm.activateSession("old-idle"); // its push hangs
    await sm.activateSession("old-rr"); // so does this one: Restart replaces the process
    const restart = sm.restartSession("old-rr");
    await vi.waitFor(() => expect(restartProcess).toHaveBeenCalled());
    for (const p of pending.filter((q) => q.sessionId === "old-rr")) p.settle(true);
    await vi.waitFor(() => {
      for (const p of pending.filter((q) => q.sessionId === "old-rr")) p.settle(true);
      expect(sm.hasActiveSession("old-rr")).toBe(true);
    });
    await restart.catch(() => {});
    expect(sm.hasActiveSession("old-idle")).toBe(false); // let go with the old process

    const idleCalls = () => pending.filter((q) => q.sessionId === "old-idle").length;
    const before = idleCalls();
    pending.find((q) => q.sessionId === "old-idle")!.settle(true); // the old push lands late
    await new Promise((r) => setTimeout(r, 10));
    expect(idleCalls()).toBe(before);
    expect(sm.getSession("old-idle")!.messageCache).toEqual([]);
  });
});
