import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The races around a pre-created chat (the standby) and setup terminals, run with the REAL freshness check and setup
 * activity over scratch config files — session-manager.test.ts mocks the check.
 *
 * Found on Windows: fal.ai was added from the Providers tab and the next New chat claimed a standby from before the
 * add, with no fal.ai tools. Leaving the Providers tab closes its setup terminal while New chat is being handled, so
 * the replacement standby is created while the terminal is still open and the close's settle lands while it is being
 * created — when the settle has nothing to replace.
 */
const h = vi.hoisted(() => ({ agentDir: "", claudeDir: "", pm: null as unknown }));

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: () => h.agentDir,
  getLibiHome: () => h.agentDir,
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));
vi.mock("@/lib/agents/libi-registration", () => ({
  readLibiCodexEntryShape: vi.fn(async () => "unknown"),
  claudeConfigPath: () => `${h.claudeDir}/.claude.json`,
}));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ clearSignInConfirmation: vi.fn() }));
vi.mock("@/lib/mcp-config", () => ({ getMcpServersForAcp: vi.fn(() => []), onMcpConfigInvalidated: vi.fn() }));
vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({ getAgentModelId: vi.fn(() => null), setAgentModelId: vi.fn() }));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({ createClient: vi.fn().mockReturnValue({}), cleanUserMessageParts: vi.fn() })),
}));
vi.mock("@/lib/agents/process-manager", () => ({ getProcessManager: () => h.pm }));

import { getSessionManager, refreshStandbyWhenSetupSettles, SessionManager } from "@/lib/sessions/session-manager";
import { __resetSetupActivity, noteSetupTerminalClosed, noteSetupTerminalOpened } from "@/lib/terminal/setup-activity";

const FAL = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer test-key" } };
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let root: string;
let tick = 0;
function writeClaudeJson(value: unknown): void {
  const file = path.join(h.claudeDir, ".claude.json");
  fs.writeFileSync(file, JSON.stringify(value));
  const at = new Date(Date.now() + ++tick * 1000);
  fs.utimesSync(file, at, at);
}

function createPm() {
  const connection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn(),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  const pm = {
    getConnection: vi.fn(() => connection),
    warmProcess: vi.fn().mockResolvedValue(undefined),
    getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
    setSessionManagerHooks: vi.fn(),
    spawnedWithShellEnv: vi.fn(() => true),
    restartProcess: vi.fn(),
    pendingRestart: vi.fn(() => undefined),
  };
  return { pm, connection };
}

/** A `newSession` that answers only when the test says so. */
function deferredSession(connection: ReturnType<typeof createPm>["connection"]) {
  let resolve!: (value: { sessionId: string }) => void;
  connection.newSession.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (sessionId: string) => resolve({ sessionId });
}

let sm: SessionManager;
let pm: ReturnType<typeof createPm>["pm"];
let connection: ReturnType<typeof createPm>["connection"];
let unsubscribe: () => void;
let readyFlags: boolean[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-standby-race-"));
  h.claudeDir = path.join(root, "claude");
  h.agentDir = path.join(root, "agent");
  fs.mkdirSync(h.claudeDir, { recursive: true });
  fs.mkdirSync(h.agentDir, { recursive: true });
  writeClaudeJson({ mcpServers: {} });
  __resetSetupActivity();
  ({ pm, connection } = createPm());
  h.pm = pm;
  sm = new SessionManager();
  sm.setProcessManager(pm as never);
  await sm.loadInitialSessions("claude-code");
  unsubscribe = refreshStandbyWhenSetupSettles(() => sm);
  readyFlags = [];
  const emit = (sm as unknown as { emitSystemEvent: (e: { type: string; ready?: boolean }) => void }).emitSystemEvent.bind(sm);
  vi.spyOn(sm as unknown as { emitSystemEvent: (e: { type: string; ready?: boolean }) => void }, "emitSystemEvent").mockImplementation((e) => {
    if (e.type === "standby-ready") readyFlags.push(Boolean(e.ready));
    emit(e);
  });
});

afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("standby vs setup terminals, with the real freshness check", () => {
  it("New chat while the Providers terminal is open, whose close lands while the replacement is being created: the replacement is replaced before it is ever announced ready, and the next chat claims a current standby", async () => {
    connection.newSession.mockResolvedValueOnce({ sessionId: "standby-old" });
    await sm.createStandbySession();
    noteSetupTerminalOpened();

    const finishReplacement = deferredSession(connection);
    connection.newSession.mockResolvedValueOnce({ sessionId: "fresh-chat" });
    const opening = sm.createSession();
    expect(await opening).toBe("fresh-chat");
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: "standby-old" });

    // Leaving the tab closes the terminal while the replacement is still being created: the settle finds nothing.
    noteSetupTerminalClosed();
    await flushMicrotasks();
    readyFlags.length = 0;
    connection.newSession.mockResolvedValueOnce({ sessionId: "standby-current" });
    finishReplacement("standby-born-stale");

    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: "standby-born-stale" });
    // Never announced ready while it was the stale one: the button goes from not-ready straight to the current one.
    expect(readyFlags).toEqual([false, true]);
    const closesBefore = connection.closeSession.mock.calls.length;
    expect(await sm.createSession()).toBe("standby-current");
    expect(connection.closeSession.mock.calls.length).toBe(closesBefore);
  });

  it("a provider added, and its terminal closed, while a standby was being created: that standby is replaced once ready", async () => {
    noteSetupTerminalOpened();
    const finish = deferredSession(connection);
    const creating = sm.createStandbySession();
    writeClaudeJson({ mcpServers: { "fal-ai": FAL } });
    noteSetupTerminalClosed();
    await flushMicrotasks();
    connection.newSession.mockResolvedValueOnce({ sessionId: "standby-with-fal" });
    finish("standby-without-fal");
    await creating;

    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: "standby-without-fal" });
    expect(await sm.createSession()).toBe("standby-with-fal");
  });

  it("a config changed with no setup terminal around is left to the claim, which starts that chat fresh", async () => {
    const finish = deferredSession(connection);
    const creating = sm.createStandbySession();
    writeClaudeJson({ mcpServers: { "fal-ai": FAL } });
    finish("standby-before-add");
    await creating;
    expect(connection.closeSession).not.toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);

    connection.newSession.mockResolvedValue({ sessionId: "later" });
    connection.newSession.mockResolvedValueOnce({ sessionId: "replacement" }).mockResolvedValueOnce({ sessionId: "fresh-chat" });
    const chat = await sm.createSession();
    expect(chat).not.toBe("standby-before-add");
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: "standby-before-add" });
  });
});

describe("getSessionManager", () => {
  it("wires the settle: once the last setup terminal closes, the app's session manager refreshes its standby", async () => {
    const key = "__sessionManager_v3";
    const g = globalThis as Record<string, unknown>;
    const previous = g[key];
    delete g[key];
    try {
      const app = getSessionManager();
      const refresh = vi.spyOn(app, "refreshStaleStandby");
      noteSetupTerminalOpened();
      noteSetupTerminalClosed();
      await flushMicrotasks();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(pm.setSessionManagerHooks).toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete g[key];
      else g[key] = previous;
    }
  });
});
