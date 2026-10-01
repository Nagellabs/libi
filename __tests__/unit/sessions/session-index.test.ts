import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SES-4 (full-verification F10): the sidebar's list came from the agent's `session/list` alone, so
 * a chat whose transcript was moved aside vanished after a restart and its "history isn't on this
 * computer any more" note could not be reached. libi now keeps its own index of the chats it has
 * shown (`lib/sessions/session-index.ts`) and merges it into the listing: an indexed id the agent no
 * longer lists stays, as an UNLISTED row, for a bounded window or until the user removes it. Only
 * the agent's own rejection of the load says its history is missing (review I1, I2).
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
import { fileSessionIndex, type SessionIndex } from "@/lib/sessions/session-index";
import { isAgentHistoryMissing, ACP_RESOURCE_NOT_FOUND_CODE } from "@/lib/sessions/history-missing";
import { MISSING_WINDOW_MS } from "@/lib/sessions/session-index";

type Listed = { sessionId: string; title?: string | null; updatedAt?: string | null; cwd?: string };

function makeConn(listed: { current: Listed[] }) {
  return {
    listSessions: vi.fn(async () => ({ sessions: listed.current.map((s) => ({ cwd: "/tmp/libi-test-agent", ...s })), nextCursor: null })),
    newSession: vi.fn(async () => ({ sessionId: "fresh-1", modes: { availableModes: [{ id: "default" }] } })),
    loadSession: vi.fn(async () => ({})),
    closeSession: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(async () => undefined),
  };
}

let dir: string;
let indexFile: string;
let index: SessionIndex;
let listed: { current: Listed[] };
let conn: ReturnType<typeof makeConn>;

/** A fresh SessionManager over the same index file — what a libi restart is. */
function boot(opts: { canList?: boolean } = {}): SessionManager {
  const sm = new SessionManager();
  sm.setSessionIndex(index);
  sm.setProcessManager({
    getConnection: vi.fn(() => conn as never),
    warmProcess: vi.fn(async () => {}),
    getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: opts.canList ?? true })),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
    pendingRestart: vi.fn(() => null),
  });
  return sm;
}

const ids = (sm: SessionManager) => sm.getAllSessions().map((s) => s.sessionId);
const onDisk = () => (fs.existsSync(indexFile) ? Object.keys(JSON.parse(fs.readFileSync(indexFile, "utf8")).sessions) : []);

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-session-index-"));
  indexFile = path.join(dir, "state", "session-index.json");
  index = fileSessionIndex(indexFile);
  listed = { current: [] };
  conn = makeConn(listed);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager + the libi-side chat index (SES-4)", () => {
  it("an indexed chat the agent no longer lists stays listed as UNLISTED; opening it asks the agent, and only its rejection says history missing", async () => {
    listed.current = [
      { sessionId: "kept", title: "Kept chat", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "gone", title: "Beach video", updatedAt: "2026-09-21T10:00:00.000Z" },
    ];
    await boot().loadInitialSessions("claude-code");
    expect(onDisk().sort()).toEqual(["gone", "kept"]);

    // The transcript of "gone" is moved aside; libi restarts.
    listed.current = [{ sessionId: "kept", title: "Kept chat", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");

    expect(ids(sm)).toEqual(["gone", "kept"]); // still listed, in its place by date
    const gone = sm.getSession("gone")!;
    expect(gone.historyUnlisted).toBe(true);
    expect(gone.historyMissing).toBeFalsy(); // a listing is not proof (review I1)
    expect(gone.title).toBe("Beach video");
    expect(sm.getSession("kept")!.historyUnlisted).toBeFalsy();

    // Opening it asks the agent once; its rejection is what says "history missing".
    conn.loadSession.mockRejectedValueOnce(Object.assign(new Error("Resource not found: gone"), { code: ACP_RESOURCE_NOT_FOUND_CODE }));
    const err = await sm.activateSession("gone").catch((e: unknown) => e);
    expect(isAgentHistoryMissing(err)).toBe(true);
    expect(conn.loadSession).toHaveBeenCalledOnce();
    expect(gone.historyMissing).toBe(true);
    // …and the next open answers at once, without asking again.
    const again = await sm.activateSession("gone").catch((e: unknown) => e);
    expect(isAgentHistoryMissing(again)).toBe(true);
    expect(conn.loadSession).toHaveBeenCalledOnce();
  });

  it("an unlisted chat whose history IS there (Codex: another provider, an archived thread) loads normally and is an ordinary chat again", async () => {
    listed.current = [
      { sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "archived", title: "Archived", updatedAt: "2026-09-21T10:00:00.000Z" },
    ];
    await boot().loadInitialSessions("codex");
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("codex");
    expect(sm.getSession("archived")!.historyUnlisted).toBe(true);
    expect(index.list().find((e) => e.sessionId === "archived")!.missingSince).not.toBeNull();

    await sm.activateSession("archived");
    expect(conn.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "archived" }));
    const e = sm.getSession("archived")!;
    expect(e.active).toBe(true);
    expect(e.historyUnlisted).toBe(false);
    expect(e.historyMissing).toBeFalsy();
    expect(index.list().find((x) => x.sessionId === "archived")!.missingSince).toBeNull();
  });

  it("a later listing that has the chat again clears the unlisted flag and its missingSince", async () => {
    listed.current = [
      { sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "b", title: "B", updatedAt: "2026-09-21T10:00:00.000Z" },
    ];
    await boot().loadInitialSessions("claude-code");
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(sm.getSession("b")!.historyUnlisted).toBe(true);

    listed.current = [
      { sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "b", title: "B", updatedAt: "2026-09-21T10:00:00.000Z" },
    ];
    await sm.syncSessions();
    expect(sm.getSession("b")!.historyUnlisted).toBe(false);
    expect(index.list().find((e) => e.sessionId === "b")!.missingSince).toBeNull();
  });

  it("an EMPTY listing proves nothing: no chat is marked, none is dropped", async () => {
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const first = boot();
    await first.loadInitialSessions("claude-code");
    await first.createSession(); // a never-used chat too
    listed.current = [];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual([]);
    expect(onDisk().sort()).toEqual(["a", "fresh-1"]);
  });

  it("an unlisted chat is shown for MISSING_WINDOW_MS from when it first went unlisted, then its entry is dropped", async () => {
    listed.current = [
      { sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "old", title: "Old", updatedAt: "2026-08-01T10:00:00.000Z" },
    ];
    await boot().loadInitialSessions("claude-code");
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0);
      const first = boot();
      await first.loadInitialSessions("claude-code");
      expect(ids(first)).toContain("old");
      const since = index.list().find((e) => e.sessionId === "old")!.missingSince;
      expect(since).toBe(new Date(t0).toISOString());

      // Still inside the window: shown, and missingSince is not moved forward.
      vi.setSystemTime(t0 + MISSING_WINDOW_MS - 60_000);
      const inside = boot();
      await inside.loadInitialSessions("claude-code");
      expect(ids(inside)).toContain("old");
      expect(index.list().find((e) => e.sessionId === "old")!.missingSince).toBe(since);

      // Past it: not shown, and gone from the file.
      vi.setSystemTime(t0 + MISSING_WINDOW_MS + 60_000);
      const past = boot();
      await past.loadInitialSessions("claude-code");
      expect(ids(past)).toEqual(["a"]);
      expect(onDisk()).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Remove from list deletes the index entry, and the chat stays gone after the next restart", async () => {
    listed.current = [
      { sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" },
      { sessionId: "gone", title: "Beach video", updatedAt: "2026-09-21T10:00:00.000Z" },
    ];
    await boot().loadInitialSessions("claude-code");
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual(["gone", "a"]);

    expect(sm.forgetSession("gone")).toBe("forgotten");
    expect(ids(sm)).toEqual(["a"]);
    expect(onDisk()).toEqual(["a"]);

    const next = boot();
    await next.loadInitialSessions("claude-code");
    expect(ids(next)).toEqual(["a"]);
  });

  it("Remove from list is refused for a chat whose history is there, and for an unknown id", async () => {
    listed.current = [{ sessionId: "kept", title: "Kept", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(sm.forgetSession("kept")).toBe("refused");
    expect(ids(sm)).toEqual(["kept"]);
    expect(onDisk()).toEqual(["kept"]);
    expect(sm.forgetSession("nope")).toBe("not_found");
  });

  it("a chat only the index knows (not in memory — another agent's) is not_found and its entry is kept (review M8a)", async () => {
    index.record([{ sessionId: "codex-chat", agentId: "codex", title: "C", updatedAt: "2026-09-20T10:00:00.000Z", hasTranscript: true }]);
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(sm.forgetSession("codex-chat")).toBe("not_found");
    expect(onDisk()).toEqual(["codex-chat"]);
  });

  it("a chat the agent lists is not duplicated", async () => {
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    await boot().loadInitialSessions("claude-code");
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual(["a"]);
    expect(sm.getSession("a")!.historyMissing).toBeFalsy();
  });

  it("a chat created and never used (no transcript ever) is not surfaced after a restart, and is pruned", async () => {
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    const id = await sm.createSession();
    expect(id).toBe("fresh-1");
    expect(index.list()).toContainEqual(expect.objectContaining({ sessionId: "fresh-1", agentId: "claude-code", hasTranscript: false }));

    const next = boot();
    await next.loadInitialSessions("claude-code");
    expect(ids(next)).toEqual(["a"]);
    expect(onDisk()).toEqual(["a"]);
  });

  it("a chat that was loaded (resumed) counts as having a transcript", async () => {
    listed.current = [{ sessionId: "r", title: "R", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    // As if indexed by nothing but the load below: a fresh index over an emptied file.
    fs.rmSync(indexFile, { force: true });
    sm.setSessionIndex(fileSessionIndex(indexFile));
    await sm.activateSession("r");
    expect(fileSessionIndex(indexFile).list()).toEqual([expect.objectContaining({ sessionId: "r", title: "R", hasTranscript: true })]);
  });

  it("a rename the agent reports on the next sync is written to the index", async () => {
    listed.current = [{ sessionId: "t", title: null, updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    listed.current = [{ sessionId: "t", title: "Product ad", updatedAt: "2026-09-20T11:00:00.000Z" }];
    await sm.syncSessions();
    expect(index.list()).toEqual([
      { sessionId: "t", agentId: "claude-code", title: "Product ad", updatedAt: "2026-09-20T11:00:00.000Z", hasTranscript: true, missingSince: null },
    ]);
  });

  it("a listing that FAILS surfaces nothing as missing (a failed list is not an empty one)", async () => {
    listed.current = [{ sessionId: "x", title: "X", updatedAt: "2026-09-20T10:00:00.000Z" }];
    await boot().loadInitialSessions("claude-code");
    conn.listSessions.mockRejectedValueOnce(Object.assign(new Error("Authentication required"), { code: -32000 }));
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual([]);
    expect(onDisk()).toEqual(["x"]);
  });

  it("only the loading agent's indexed chats are merged", async () => {
    index.record([{ sessionId: "codex-chat", agentId: "codex", title: "C", updatedAt: "2026-09-20T10:00:00.000Z", hasTranscript: true }]);
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual(["a"]);
    expect(onDisk().sort()).toEqual(["a", "codex-chat"]);
  });

  it("an index that can't be read or written never breaks the listing", async () => {
    const broken: SessionIndex = {
      list: () => { throw new Error("EACCES"); },
      record: () => { throw new Error("EACCES"); },
      remove: () => { throw new Error("EACCES"); },
    };
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const sm = boot();
    sm.setSessionIndex(broken);
    await sm.loadInitialSessions("claude-code");
    expect(ids(sm)).toEqual(["a"]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "session-manager", op: "session_index_failed" }), expect.any(String));
  });

  it("the index file is private (0600), read once per process, and written through", async () => {
    listed.current = [{ sessionId: "a", title: "A", updatedAt: "2026-09-20T10:00:00.000Z" }];
    const reads = vi.spyOn(fs, "readFileSync");
    const sm = boot();
    await sm.loadInitialSessions("claude-code");
    for (let i = 0; i < 5; i++) await sm.syncSessions(); // one per turn
    const indexReads = reads.mock.calls.filter(([f]) => String(f) === indexFile).length;
    reads.mockRestore();
    expect(indexReads).toBe(1);
    if (process.platform !== "win32") expect(fs.statSync(indexFile).mode & 0o777).toBe(0o600);
    // A fresh reader sees what was written.
    expect(fileSessionIndex(indexFile).list().map((e) => e.sessionId)).toEqual(["a"]);
  });
});
