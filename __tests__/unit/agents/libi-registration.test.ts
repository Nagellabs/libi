// Is libi registered with the user's own Claude Code / Codex, and on which
// port? Every case runs against fixture configs in a temp dir and an injected
// codex resolver + lister — the real ~/.claude.json and ~/.codex are never read,
// and no real codex is ever spawned.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverLogger } from "@/lib/logger";
import {
  claudeConfigPath, codexSpawnShape, detectLibiRegistration, libiRegistrationFromClaudeConfig,
  libiRegistrationFromCodexList,
} from "@/lib/agents/libi-registration";
import { listCodexMcpServers } from "@/lib/agents/codex-mcp-listing";
import type { CodexMcpListEntry } from "@/lib/codex-config/codex-cli";
import { setMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-handle";
import { DEFAULT_MCP_PORT } from "@/lib/libi-home";

// A script CLI runs through libi's node; pin which node that is so the spawned command is assertable.
vi.mock("@/lib/runtime/node-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime/node-runtime")>()),
  resolveNodeCommand: () => "/managed/bin/node",
}));

const AGENT_DIR = "/tmp/libi-agent-dir";
const LIBI_CODEX: CodexMcpListEntry = {
  name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:3457/mcp?agent=codex" },
};
const NATIVE_CODEX = { path: "/opt/codex", realPath: "/opt/codex", execPath: "/opt/codex", version: "0.160.0", meetsMinimum: true };

// The shape npm's cmd-shim writes for a globally installed @openai/codex on Windows.
const CODEX_CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`;

/** Run `fn` with `process.platform` faked — the only way to exercise a Windows shim off-Windows. */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("claudeConfigPath (CLAUDE_CONFIG_DIR)", () => {
  it("defaults to ~/.claude.json", () => {
    expect(claudeConfigPath({}, "/Users/me")).toBe("/Users/me/.claude.json");
  });
  it("honours CLAUDE_CONFIG_DIR the way Claude Code does: <dir>/.claude.json, not the home file", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/tmp/cc" }, "/Users/me")).toBe(path.join("/tmp/cc", ".claude.json"));
  });
});

describe("libiRegistrationFromClaudeConfig (pure)", () => {
  it("user-scope libi on the current port → connected/user", () => {
    const cfg = { mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } };
    expect(libiRegistrationFromClaudeConfig(cfg, AGENT_DIR, 3457)).toEqual({ state: "connected", scope: "user", url: "http://127.0.0.1:3457/mcp" });
  });
  it("local-scope (projects[agent dir]) libi is found too", () => {
    const cfg = { projects: { [AGENT_DIR]: { mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } } } };
    expect(libiRegistrationFromClaudeConfig(cfg, AGENT_DIR, 3457).scope).toBe("local");
  });
  it("user scope wins over local scope when both exist", () => {
    const cfg = {
      mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3999/mcp" } },
      projects: { [AGENT_DIR]: { mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } } },
    };
    expect(libiRegistrationFromClaudeConfig(cfg, AGENT_DIR, 3457)).toEqual({ state: "stale-port", scope: "user", url: "http://127.0.0.1:3999/mcp" });
  });
  it("a different port → stale-port", () => {
    const cfg = { mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3999/mcp" } } };
    expect(libiRegistrationFromClaudeConfig(cfg, AGENT_DIR, 3457)).toEqual({ state: "stale-port", scope: "user", url: "http://127.0.0.1:3999/mcp" });
  });
  it("no libi entry → not-connected; unparseable → unknown", () => {
    expect(libiRegistrationFromClaudeConfig({ mcpServers: { other: {} } }, AGENT_DIR, 3457)).toEqual({ state: "not-connected" });
    expect(libiRegistrationFromClaudeConfig(null, AGENT_DIR, 3457)).toEqual({ state: "unknown" });
  });
  it("an array config is not a config → unknown, even when an element looks like one", () => {
    expect(libiRegistrationFromClaudeConfig([], AGENT_DIR, 3457)).toEqual({ state: "unknown" });
    expect(libiRegistrationFromClaudeConfig([{ mcpServers: { libi: { url: "http://127.0.0.1:3457/mcp" } } }], AGENT_DIR, 3457)).toEqual({ state: "unknown" });
  });
});

describe("libiRegistrationFromCodexList (pure)", () => {
  it("parses codex mcp list --json", () => {
    expect(libiRegistrationFromCodexList([LIBI_CODEX], 3457)).toEqual({ state: "connected", url: "http://127.0.0.1:3457/mcp?agent=codex" });
    expect(libiRegistrationFromCodexList([LIBI_CODEX], 3458).state).toBe("stale-port");
    expect(libiRegistrationFromCodexList([], 3457)).toEqual({ state: "not-connected" });
    expect(libiRegistrationFromCodexList(null, 3457)).toEqual({ state: "unknown" });
  });
  it("a DISABLED libi entry is stale-port even on the current port, so the row offers Reconnect (which re-creates it enabled)", () => {
    const disabled = { ...LIBI_CODEX, enabled: false };
    expect(libiRegistrationFromCodexList([disabled], 3457)).toEqual({ state: "stale-port", url: "http://127.0.0.1:3457/mcp?agent=codex" });
    expect(libiRegistrationFromCodexList([disabled], 3999)).toEqual({ state: "stale-port", url: "http://127.0.0.1:3457/mcp?agent=codex" });
  });
  it("a libi entry with no usable url (hand-written stdio, null / malformed transport) → stale-port with no url", () => {
    const stdio = { name: "libi", enabled: true, transport: { type: "stdio", command: "node" } };
    expect(libiRegistrationFromCodexList([stdio], 3457)).toEqual({ state: "stale-port" });
    const nullTransport = { name: "libi", enabled: true, transport: null } as unknown as CodexMcpListEntry;
    expect(libiRegistrationFromCodexList([nullTransport], 3457)).toEqual({ state: "stale-port" });
    const numberUrl = { name: "libi", enabled: true, transport: { type: "streamable_http", url: 3457 } } as unknown as CodexMcpListEntry;
    expect(libiRegistrationFromCodexList([numberUrl], 3457)).toEqual({ state: "stale-port" });
  });
  it("malformed items (null, a number, a bare string) are skipped — never matched, never thrown on", () => {
    const junk = [null, 42, "libi"] as unknown as CodexMcpListEntry[];
    expect(libiRegistrationFromCodexList(junk, 3457)).toEqual({ state: "not-connected" });
    expect(libiRegistrationFromCodexList([...junk, LIBI_CODEX], 3457).state).toBe("connected");
  });
  it("a listing that is not an array is no information → unknown", () => {
    expect(libiRegistrationFromCodexList({} as unknown as CodexMcpListEntry[], 3457)).toEqual({ state: "unknown" });
  });
});

describe("codexSpawnShape / listCodexMcpServers — codex runs the way the resolver ran its --version", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-reg-shape-")));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("a native codex runs as its realPath — not the PATH hit, not execPath", () => {
    const cli = { path: "/usr/local/bin/codex", realPath: "/fixture/real/codex", execPath: "/fixture/exec/codex" };
    expect(codexSpawnShape(cli)).toEqual({ command: "/fixture/real/codex", args: [] });
  });

  it("a script realPath runs through node", () => {
    const cli = { path: "/usr/local/bin/codex", realPath: "/fixture/lib/codex/bin/codex.js", execPath: "/fixture/exec/codex" };
    expect(codexSpawnShape(cli)).toEqual({ command: "/managed/bin/node", args: ["/fixture/lib/codex/bin/codex.js"] });
  });

  it("a Windows npm .cmd shim runs its JS target through node — the .cmd itself would fail with EINVAL", async () => {
    const shim = path.join(home, "codex.cmd");
    fs.writeFileSync(shim, CODEX_CMD_SHIM);
    await withPlatform("win32", async () => {
      const cli = { path: path.join(home, "bin", "codex.cmd"), realPath: shim, execPath: path.join(home, "exec", "codex.cmd") };
      expect(codexSpawnShape(cli)).toEqual({
        command: "/managed/bin/node",
        args: [path.resolve(home, "node_modules", "@openai", "codex", "bin", "codex.js")],
      });
    });
  });

  it("listCodexMcpServers spawns the shape's command, its args before `mcp list --json`, against the given CODEX_HOME, bounded at the shared 15 s", async () => {
    const spawner = vi.fn(async () => ({ stdout: JSON.stringify([LIBI_CODEX]), stderr: "" }));
    const entries = await listCodexMcpServers({ command: "/managed/bin/node", args: ["/fixture/codex.js"] }, { spawner, codexHome: home });
    expect(spawner).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spawner.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv; timeout?: number }];
    expect(file).toBe("/managed/bin/node");
    expect(args).toEqual(["/fixture/codex.js", "mcp", "list", "--json"]);
    expect(opts.timeout).toBe(15_000);
    expect(opts.env?.CODEX_HOME).toBe(home);
    expect(entries).toEqual([LIBI_CODEX]);
  });
});

describe("detectLibiRegistration", () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-reg-")));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads Claude's file and lists codex through the resolved realPath's spawn shape; a missing file is not-connected", async () => {
    const cfg = path.join(home, ".claude.json");
    const codexList = vi.fn(async () => [LIBI_CODEX]);
    const r = await detectLibiRegistration({
      claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => ({
        path: "/usr/local/bin/codex", realPath: "/fixture/lib/codex/bin/codex.js", execPath: "/fixture/exec/codex",
        version: "0.160.0", meetsMinimum: true,
      }),
      codexList,
    });
    expect(r["claude-code"]).toEqual({ state: "not-connected" });
    expect(r.codex.state).toBe("connected");
    expect(codexList).toHaveBeenCalledWith({ command: "/managed/bin/node", args: ["/fixture/lib/codex/bin/codex.js"] });
  });

  it("no usable codex → not-connected without spawning; a list failure → unknown", async () => {
    const cfg = path.join(home, ".claude.json");
    fs.writeFileSync(cfg, "{not json");
    const r = await detectLibiRegistration({
      claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => null,
      codexList: async () => { throw new Error("must not run"); },
    });
    expect(r["claude-code"]).toEqual({ state: "unknown" });
    expect(r.codex).toEqual({ state: "not-connected" });
    const r2 = await detectLibiRegistration({
      claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => NATIVE_CODEX,
      codexList: async () => null,
    });
    expect(r2.codex).toEqual({ state: "unknown" });
  });

  it("a codex that could not be asked (null listing) is logged under libi-registration with booleans only", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    await detectLibiRegistration({
      claudeConfigPath: path.join(home, "none.json"), agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => NATIVE_CODEX,
      codexList: async () => null,
    });
    const call = warn.mock.calls.find(([fields]) => (fields as { op?: unknown }).op === "codex_list_no_answer");
    expect(call).toBeDefined();
    const { tag, op, ...rest } = call![0] as unknown as Record<string, unknown>;
    expect(tag).toBe("libi-registration");
    expect(op).toBe("codex_list_no_answer");
    expect(Object.keys(rest).length).toBeGreaterThan(0);
    expect(Object.values(rest).every((v) => typeof v === "boolean" || typeof v === "number")).toBe(true);
  });

  it("a config file that exists but cannot be READ (not ENOENT) → unknown, not not-connected", async () => {
    const cfg = path.join(home, ".claude.json");
    fs.mkdirSync(cfg); // readFileSync → EISDIR
    const r = await detectLibiRegistration({
      claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457, resolveCodex: async () => null,
    });
    expect(r["claude-code"]).toEqual({ state: "unknown" });
  });

  it("a config FILE holding a JSON array → unknown", async () => {
    const cfg = path.join(home, ".claude.json");
    fs.writeFileSync(cfg, JSON.stringify([{ mcpServers: { libi: { url: "http://127.0.0.1:3457/mcp" } } }]));
    const r = await detectLibiRegistration({ claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457, resolveCodex: async () => null });
    expect(r["claude-code"]).toEqual({ state: "unknown" });
  });

  it("a libi entry in the agent dir's .mcp.json is not a registration — only user and local scope count", async () => {
    const agentDir = path.join(home, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, ".mcp.json"), JSON.stringify({ mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } }));
    const r = await detectLibiRegistration({
      claudeConfigPath: path.join(home, "none.json"), agentDir, currentPort: 3457, resolveCodex: async () => null,
    });
    expect(r["claude-code"]).toEqual({ state: "not-connected" });
  });

  it("a found-but-below-minimum codex is still read (like Claude); only null / broken skip the spawn", async () => {
    const codexList = vi.fn(async () => [LIBI_CODEX]);
    const r = await detectLibiRegistration({
      claudeConfigPath: path.join(home, "none.json"), agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => ({ ...NATIVE_CODEX, version: "0.1.0", meetsMinimum: false }),
      codexList,
    });
    expect(r.codex.state).toBe("connected");
    const broken = await detectLibiRegistration({
      claudeConfigPath: path.join(home, "none.json"), agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => ({ foundButBroken: true, path: "/opt/codex" }),
      codexList,
    });
    expect(broken.codex).toEqual({ state: "not-connected" });
    expect(codexList).toHaveBeenCalledTimes(1);
  });

  it("only: a Claude-only poll never resolves or spawns codex (bounds the spawn cost)", async () => {
    const resolveCodex = vi.fn(async () => null);
    const codexList = vi.fn(async () => []);
    const r = await detectLibiRegistration({
      claudeConfigPath: path.join(home, "none.json"), agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex, codexList, only: "claude-code",
    });
    expect(r["claude-code"]).toEqual({ state: "not-connected" });
    expect(r.codex).toEqual({ state: "not-connected" });
    expect(resolveCodex).not.toHaveBeenCalled();
    expect(codexList).not.toHaveBeenCalled();
  });

  it("while a first launch gave up with nothing published, a registration naming the default port is current, not stale", async () => {
    const prevPin = process.env.LIBI_MCP_PORT;
    delete process.env.LIBI_MCP_PORT;
    // The endpoint gave up on a fallback it moved to while the default was busy.
    setMcpHttpChild({
      port: 3501,
      advertisedPort: 3501,
      publishedPort: null,
      stop: async () => {},
      restart: async () => {},
      status: () => "gave-up",
      ownsHealthAnswer: () => false,
    });
    try {
      const cfg = path.join(home, ".claude.json");
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { libi: { type: "http", url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp` } } }));
      const r = await detectLibiRegistration({
        claudeConfigPath: cfg, agentDir: AGENT_DIR, resolveCodex: async () => NATIVE_CODEX, codexList: async () => [LIBI_CODEX],
      });
      expect(r["claude-code"].state).toBe("connected");
      expect(r.codex.state).toBe("connected");
    } finally {
      setMcpHttpChild(null);
      if (prevPin === undefined) delete process.env.LIBI_MCP_PORT;
      else process.env.LIBI_MCP_PORT = prevPin;
    }
  });

  it("only: a Codex-only poll never reads Claude's config, even when it holds a libi entry", async () => {
    const cfg = path.join(home, ".claude.json");
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } }));
    const readClaudeConfig = vi.fn(() => ({}));
    const r = await detectLibiRegistration({
      claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457,
      resolveCodex: async () => NATIVE_CODEX, codexList: async () => [LIBI_CODEX], readClaudeConfig, only: "codex",
    });
    expect(r["claude-code"]).toEqual({ state: "not-connected" });
    expect(r.codex.state).toBe("connected");
    expect(readClaudeConfig).not.toHaveBeenCalled();
  });

  it("a throw while detecting one agent makes only THAT agent's row unknown", async () => {
    const cfg = path.join(home, ".claude.json");
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } }));
    const base = { claudeConfigPath: cfg, agentDir: AGENT_DIR, currentPort: 3457 };

    const claudeThrows = await detectLibiRegistration({
      ...base,
      readClaudeConfig: () => { throw new Error("reader failed"); },
      resolveCodex: async () => NATIVE_CODEX, codexList: async () => [LIBI_CODEX],
    });
    expect(claudeThrows).toEqual({ "claude-code": { state: "unknown" }, codex: { state: "connected", url: LIBI_CODEX.transport.url } });

    const resolverThrows = await detectLibiRegistration({
      ...base, resolveCodex: async () => { throw new Error("resolver failed"); }, codexList: async () => [LIBI_CODEX],
    });
    expect(resolverThrows["claude-code"]).toEqual({ state: "connected", scope: "user", url: "http://127.0.0.1:3457/mcp" });
    expect(resolverThrows.codex).toEqual({ state: "unknown" });

    const listerThrows = await detectLibiRegistration({
      ...base, resolveCodex: async () => NATIVE_CODEX, codexList: async () => { throw new Error("lister failed"); },
    });
    expect(listerThrows["claude-code"].state).toBe("connected");
    expect(listerThrows.codex).toEqual({ state: "unknown" });
  });
});
