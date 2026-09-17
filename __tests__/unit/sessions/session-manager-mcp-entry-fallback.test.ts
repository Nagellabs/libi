/**
 * The one-shot `newSession` retry that keeps a Codex chat openable when libi's
 * deliberate entry-name collision turns fatal.
 *
 * Background: libi names its ACP MCP entry `libi` so that it REPLACES the
 * `[mcp_servers.libi]` a `libi connect`-ed machine already has, instead of
 * mounting libi twice. Codex resolves that collision by merging the override
 * into the config table FIELD BY FIELD — so a user whose entry is a stdio one
 * (older libi versions wrote those) ends up with `command` and `url` in one
 * table and codex refuses the entire config. `thread/start` fails and there is
 * no chat at all.
 *
 * The recovery is reactive: observe THAT error, retry once under a
 * non-colliding name, accept the duplicated tool surface for that session.
 * These tests are about the boundaries — that it fires, that it fires only
 * there, and that it cannot become a loop.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

/** Recording fake — the log line IS the deliverable for the silent shape. */
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
  getMcpServersForAcp: vi.fn(() => [{ type: "http", name: "libi", url: "http://x/mcp" }]),
  getMcpServersForAcpFallback: vi.fn(() => [
    { type: "http", name: "libi-app", url: "http://x/mcp" },
  ]),
  onMcpConfigInvalidated: vi.fn(),
}));

vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));

// The shape probe reads the codex listing libi's Codex readers share
// (lib/agents/codex-mcp-listing.ts). Only codex's own `mcp list` and the CLI
// resolver are faked, so no codex is spawned and no CODEX_HOME is read, while
// the diagnostic walks its real path through the shared listing. It is
// fire-and-forget, so a listing with nothing to say leaves every assertion
// below about the retry alone.
const shapeProbe = vi.hoisted(() => ({
  list: vi.fn<(opts: unknown) => Promise<unknown[] | null>>(async () => []),
  resolve: vi.fn<(id: string) => Promise<unknown>>(async () => null),
}));
vi.mock("@/lib/codex-config/codex-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-config/codex-cli")>()),
  mcpListJson: (opts: unknown) => shapeProbe.list(opts),
}));
vi.mock("@/lib/agents/cli/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/cli/resolve")>()),
  resolveAgentCli: (id: string) => shapeProbe.resolve(id),
}));
vi.mock("@/lib/codex-config/canonical", () => ({
  resolveCodexHome: vi.fn(() => "/tmp/libi-test-codex-home"),
}));

import { SessionManager } from "@/lib/sessions/session-manager";
import { LIBI_MCP_FALLBACK_ENTRY_NAME } from "@/lib/mcp/agent-surface";
import { serverLogger } from "@/lib/logger";
import { __clearCodexMcpListing } from "@/lib/agents/codex-mcp-listing";

const CODEX_CLI = { path: "/fixture/codex", realPath: "/fixture/codex", execPath: "/fixture/codex", version: "0.160.0", meetsMinimum: true };
const LIBI_HTTP = { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:3457/mcp?agent=codex" } };
const HIGGSFIELD = { name: "higgsfield", enabled: true, transport: { type: "streamable_http", url: "https://mcp.higgsfield.ai/mcp" }, auth_status: "not_logged_in" };

/** Every `op` the server logger was given, for asserting on one line. */
function loggedOps(): string[] {
  return vi
    .mocked(serverLogger.warn)
    .mock.calls.map((c) => (c[0] as { op?: string })?.op ?? "");
}

/** The literal rejection codex-acp 1.10.0 answers `session/new` with. */
function collisionError() {
  return {
    code: -32603,
    message: "Internal error",
    data:
      "failed to load configuration: url is not supported for stdio\n" +
      "in `mcp_servers.libi`\n\n\nCheck /tmp/codex-home and project .codex directories, …",
  };
}

function authError(): Error & { code: number } {
  const err = new Error("Authentication required") as Error & { code: number };
  err.code = -32000;
  return err;
}

function createMockPm() {
  const mockConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-new" }),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  return {
    pm: {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      warmProcess: vi.fn().mockResolvedValue(undefined),
      getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: false }),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    },
    mockConnection,
  };
}

/** Entry names, per `newSession` call, in order. */
function entryNames(mockConnection: ReturnType<typeof createMockPm>["mockConnection"]) {
  return mockConnection.newSession.mock.calls.map(
    (c) => (c[0] as { mcpServers: { name: string }[] }).mcpServers.map((m) => m.name).join(","),
  );
}

describe("newSession falls back to a non-colliding MCP entry name", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockPm();
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = new SessionManager();
    sm.setProcessManager(pm);
  });

  it("retries once under the fallback name and returns a working session", async () => {
    mockConnection.newSession
      .mockRejectedValueOnce(collisionError())
      .mockResolvedValue({ sessionId: "s-recovered" });
    // Adopt the agent without letting the standby consume the scripted
    // rejection, so createSession() is the call under test.
    await sm.switchAgent("codex");
    mockConnection.newSession.mockClear();
    mockConnection.newSession
      .mockRejectedValueOnce(collisionError())
      .mockResolvedValue({ sessionId: "s-recovered" });

    await expect(sm.createSession()).resolves.toBe("s-recovered");
    expect(entryNames(mockConnection)).toEqual(["libi", LIBI_MCP_FALLBACK_ENTRY_NAME]);
  });

  it("marks the agent ready — the recovered session is a real one", async () => {
    await sm.switchAgent("codex");
    mockConnection.newSession.mockClear();
    mockConnection.newSession
      .mockRejectedValueOnce(collisionError())
      .mockResolvedValue({ sessionId: "s-recovered" });

    await sm.createSession();
    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });
  });

  it("recovers the standby path too, not just createSession", async () => {
    mockConnection.newSession
      .mockRejectedValueOnce(collisionError())
      .mockResolvedValue({ sessionId: "s-standby" });

    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    expect(entryNames(mockConnection)).toEqual(["libi", LIBI_MCP_FALLBACK_ENTRY_NAME]);
    expect(sm.isStandbyReady()).toBe(true);
  });

  /**
   * The retry must not become a general-purpose "try again". An auth failure
   * that got retried under a different entry name would fail identically, cost
   * a second round-trip, and — if it ever DID succeed — silently re-duplicate
   * libi's tool surface for a reason unrelated to the entry name.
   */
  it("does not retry an auth rejection", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    await sm.switchAgent("codex");
    mockConnection.newSession.mockClear();
    mockConnection.newSession.mockRejectedValue(authError());

    await expect(sm.createSession()).rejects.toThrow(/Authentication required/);
    expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
    expect(sm.getReadiness("codex").state).toBe("needs-auth");
  });

  it.each([
    ["a transport failure", new Error("ECONNRESET")],
    ["a dead adapter", new Error("Connection closed")],
    [
      "the user's own unrelated config mistake",
      {
        code: -32603,
        message: "Internal error",
        data: "failed to load configuration: /tmp/h/config.toml:1:1: url is not supported for stdio",
      },
    ],
  ])("does not retry %s", async (_label, err) => {
    mockConnection.newSession.mockRejectedValue(err);
    await sm.switchAgent("codex");
    mockConnection.newSession.mockClear();
    mockConnection.newSession.mockRejectedValue(err);

    await expect(sm.createSession()).rejects.toBeDefined();
    expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
  });

  /**
   * Two attempts, never three — the retry calls the connection directly rather
   * than re-entering the wrapper, so a codex that answers the collision error
   * to BOTH names still terminates.
   */
  it("cannot loop when the fallback name fails the same way", async () => {
    mockConnection.newSession.mockRejectedValue(collisionError());
    await sm.switchAgent("codex");
    mockConnection.newSession.mockClear();
    mockConnection.newSession.mockRejectedValue(collisionError());

    await expect(sm.createSession()).rejects.toMatchObject({
      // The ORIGINAL error propagates: it is the one naming `mcp_servers.libi`,
      // which is what the user has to fix.
      data: expect.stringContaining("mcp_servers.libi"),
    });
    expect(mockConnection.newSession).toHaveBeenCalledTimes(2);
  });

  /**
   * The retry recovers the session, so the user sees nothing wrong — which is
   * precisely why it has to be legible in `~/.libi/logs/libi.log`. Without a
   * line here, "why does this machine carry libi's tools twice?" has no answer.
   */
  it("says in the log that it happened, and why", async () => {
    await sm.switchAgent("codex");
    vi.mocked(serverLogger.warn).mockClear();
    mockConnection.newSession
      .mockRejectedValueOnce(collisionError())
      .mockResolvedValue({ sessionId: "s-recovered" });

    await sm.createSession();

    expect(loggedOps()).toContain("mcp_entry_collision_retry");
    const call = vi
      .mocked(serverLogger.warn)
      .mock.calls.find((c) => (c[0] as { op?: string })?.op === "mcp_entry_collision_retry");
    expect(call?.[0]).toMatchObject({
      tag: "session-manager",
      agentId: "codex",
      reason: "fresh",
      fallbackNames: [LIBI_MCP_FALLBACK_ENTRY_NAME],
    });
    // The message has to say what the user will now observe.
    expect(String(call?.[1])).toMatch(/twice/i);
  });
});

/**
 * The SILENT shape: `enabled = false` survives the merge, so the session starts
 * fine and simply has no libi tools. Nothing throws, so a log line naming the
 * cause is the whole remedy — anything else would be a heuristic over a config
 * libi only reads.
 */
describe("a disabled [mcp_servers.libi] is named in the log", () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    __clearCodexMcpListing();
    shapeProbe.resolve.mockReset().mockResolvedValue(CODEX_CLI);
    shapeProbe.list.mockReset().mockResolvedValue([LIBI_HTTP]);
    sm = new SessionManager();
    sm.setProcessManager(createMockPm().pm);
  });

  /** The probe is fire-and-forget; let its microtasks land. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("warns with the cause when codex's listing shows libi's entry disabled", async () => {
    shapeProbe.list.mockResolvedValue([HIGGSFIELD, { ...LIBI_HTTP, enabled: false }]);
    await sm.switchAgent("codex");
    await sm.createSession();
    await settle();

    expect(loggedOps()).toContain("libi_mcp_entry_disabled");
    const call = vi
      .mocked(serverLogger.warn)
      .mock.calls.find((c) => (c[0] as { op?: string })?.op === "libi_mcp_entry_disabled");
    expect(call?.[0]).toMatchObject({ tag: "session-manager", agentId: "codex" });
    // Naming the fix is the point — a bare "no tools" line helps nobody.
    expect(String(call?.[1])).toMatch(/enabled = false/);
    expect(String(call?.[1])).toMatch(/libi connect/);
  });

  it.each([
    ["http", [LIBI_HTTP]],
    ["absent", [HIGGSFIELD]],
    ["stdio", [{ name: "libi", enabled: true, transport: { type: "stdio", command: "libi" } }]],
    ["unknown", null],
  ] as const)(
    "stays quiet for the %s shape — no cause, nothing to say",
    async (_shape, listing) => {
      shapeProbe.list.mockResolvedValue(listing as unknown[] | null);
      await sm.switchAgent("codex");
      await sm.createSession();
      await settle();
      expect(loggedOps()).not.toContain("libi_mcp_entry_disabled");
    },
  );

  it("never asks about a non-codex agent", async () => {
    shapeProbe.list.mockResolvedValue([{ ...LIBI_HTTP, enabled: false }]);
    await sm.switchAgent("claude-code");
    await sm.createSession();
    await settle();
    expect(shapeProbe.resolve).not.toHaveBeenCalledWith("codex");
    expect(shapeProbe.list).not.toHaveBeenCalled();
    expect(loggedOps()).not.toContain("libi_mcp_entry_disabled");
  });

  it("a listing slower than a 2 s spawn allowed — an unauthenticated HTTP entry's discovery — still names the disabled entry; sessions never wait for it, and every session start joins one run", async () => {
    let finish!: (entries: unknown[] | null) => void;
    shapeProbe.list.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await sm.switchAgent("codex");
    await expect(sm.createSession()).resolves.toBeTruthy();
    await settle();
    expect(loggedOps()).not.toContain("libi_mcp_entry_disabled");

    finish([HIGGSFIELD, { ...LIBI_HTTP, enabled: false }]);
    await settle();
    expect(loggedOps()).toContain("libi_mcp_entry_disabled");
    expect(shapeProbe.list).toHaveBeenCalledTimes(1);
    expect(shapeProbe.list).toHaveBeenCalledWith(
      expect.objectContaining({ bin: "/fixture/codex", codexHome: "/tmp/libi-test-codex-home", timeoutMs: 15_000 }),
    );
  });

  /** A diagnostic must never be able to break the session it describes. */
  it("swallows its own failure", async () => {
    shapeProbe.resolve.mockRejectedValue(new Error("codex exploded"));
    await sm.switchAgent("codex");
    await expect(sm.createSession()).resolves.toBeTruthy();
    await settle();
    expect(loggedOps()).not.toContain("libi_mcp_entry_disabled");
  });
});
