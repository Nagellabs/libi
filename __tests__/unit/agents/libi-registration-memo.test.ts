// The production path of detectLibiRegistration (nothing injected): its 5 s
// per-agent memo, the in-flight share, the clear that a setup terminal's exit
// triggers, and the shared codex listing's spawn shape and bound. How that
// listing serves provider detection too is in
// __tests__/unit/providers/detect-shared.test.ts. The resolver and the
// codex lister are module mocks and Claude's config is a temp CLAUDE_CONFIG_DIR —
// the real ~/.claude.json is never read and no codex is ever spawned.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  resolveAgentCli: vi.fn(),
  mcpListJson: vi.fn(),
  agentDir: "/fixture/agent-dir",
}));

vi.mock("@/lib/agents/cli/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/cli/resolve")>()),
  resolveAgentCli: h.resolveAgentCli,
}));
vi.mock("@/lib/codex-config/codex-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-config/codex-cli")>()),
  mcpListJson: h.mcpListJson,
}));
vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getLibiAgentDir: () => h.agentDir,
  getCurrentMcpPort: () => 3457,
}));
vi.mock("@/lib/runtime/node-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime/node-runtime")>()),
  resolveNodeCommand: () => "/managed/bin/node",
}));

import { __clearLibiRegistrationMemo, detectLibiRegistration } from "@/lib/agents/libi-registration";

const LIBI_CODEX = { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:3457/mcp?agent=codex" } };
const NATIVE_CODEX = { path: "/opt/codex", realPath: "/opt/codex", execPath: "/opt/codex", version: "0.160.0", meetsMinimum: true };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let dir: string;
const writeClaude = (withLibi: boolean) =>
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({ mcpServers: withLibi ? { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } : {} }),
  );

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-reg-memo-")));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  __clearLibiRegistrationMemo();
  h.resolveAgentCli.mockReset().mockResolvedValue(NATIVE_CODEX);
  h.mcpListJson.mockReset().mockResolvedValue([LIBI_CODEX]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __clearLibiRegistrationMemo();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("detectLibiRegistration — memo", () => {
  it("serves a repeat call within 5 s from the memo, and reads again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T10:00:00Z"));
    writeClaude(true);
    expect(await detectLibiRegistration()).toEqual({
      "claude-code": { state: "connected", scope: "user", url: "http://127.0.0.1:3457/mcp" },
      codex: { state: "connected", url: LIBI_CODEX.transport.url },
    });

    writeClaude(false);
    vi.setSystemTime(new Date("2026-09-10T10:00:04.900Z"));
    expect((await detectLibiRegistration())["claude-code"].state).toBe("connected");
    expect(h.resolveAgentCli).toHaveBeenCalledTimes(1);
    expect(h.mcpListJson).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-10T10:00:05.100Z"));
    expect((await detectLibiRegistration())["claude-code"]).toEqual({ state: "not-connected" });
    expect(h.resolveAgentCli).toHaveBeenCalledTimes(2);
    expect(h.mcpListJson).toHaveBeenCalledTimes(2);
  });

  it("a clear makes the very next call read again", async () => {
    writeClaude(true);
    await detectLibiRegistration();
    writeClaude(false);
    __clearLibiRegistrationMemo();
    expect((await detectLibiRegistration())["claude-code"]).toEqual({ state: "not-connected" });
    expect(h.resolveAgentCli).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls share one in-flight detection per agent", async () => {
    const cli = deferred<typeof NATIVE_CODEX>();
    h.resolveAgentCli.mockReturnValue(cli.promise);
    const a = detectLibiRegistration();
    const b = detectLibiRegistration();
    await Promise.resolve();
    cli.resolve(NATIVE_CODEX);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra.codex.state).toBe("connected");
    expect(h.resolveAgentCli).toHaveBeenCalledTimes(1);
    expect(h.mcpListJson).toHaveBeenCalledTimes(1);
  });

  it("a detection whose codex listing started BEFORE a clear never refills the memo after it", async () => {
    writeClaude(true);
    const listing = deferred<unknown[] | null>();
    h.mcpListJson.mockReturnValueOnce(listing.promise);
    const before = detectLibiRegistration();
    await vi.waitFor(() => expect(h.mcpListJson).toHaveBeenCalledTimes(1));
    __clearLibiRegistrationMemo();
    listing.resolve([LIBI_CODEX]);
    expect(await before).toEqual({
      "claude-code": { state: "connected", scope: "user", url: "http://127.0.0.1:3457/mcp" },
      codex: { state: "connected", url: LIBI_CODEX.transport.url },
    });

    writeClaude(false);
    h.mcpListJson.mockResolvedValue([]);
    const after = await detectLibiRegistration();
    expect(after).toEqual({ "claude-code": { state: "not-connected" }, codex: { state: "not-connected" } });
    expect(h.resolveAgentCli).toHaveBeenCalledTimes(2);
    expect(h.mcpListJson).toHaveBeenCalledTimes(2);
  });

  it("a codex that gave no listing reads unknown, never not-connected", async () => {
    h.mcpListJson.mockResolvedValue(null);
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "unknown" });
  });

  it("the shared lister runs codex through the resolver's spawn shape (a script realPath through node), bounded at 15 s", async () => {
    h.resolveAgentCli.mockResolvedValue({
      path: "/usr/local/bin/codex", realPath: "/fixture/lib/codex/bin/codex.js", execPath: "/fixture/exec/codex",
      version: "0.160.0", meetsMinimum: true,
    });
    await detectLibiRegistration({ only: "codex" });
    expect(h.mcpListJson).toHaveBeenCalledTimes(1);
    expect(h.mcpListJson).toHaveBeenCalledWith(
      expect.objectContaining({ bin: "/managed/bin/node", binArgs: ["/fixture/lib/codex/bin/codex.js"], timeoutMs: 15_000 }),
    );
  });
});
