import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether a pre-created chat still has the MCP servers a new chat would get. Real files in a scratch Claude config
 * folder, home, Codex home and agent folder; `claudeConfigPath` keeps its contract (`<CLAUDE_CONFIG_DIR>/.claude.json`,
 * else `~/.claude.json`).
 */
const h = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@/lib/libi-home", () => ({ getLibiAgentDir: () => h.agentDir, getLibiHome: () => h.agentDir }));
vi.mock("@/lib/agents/libi-registration", async () => {
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  return {
    claudeConfigPath: () =>
      process.env.CLAUDE_CONFIG_DIR
        ? nodePath.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
        : nodePath.join(nodeOs.default.homedir(), ".claude.json"),
  };
});

import { captureStandbyFreshness, staleStandbyReason } from "@/lib/sessions/standby-freshness";
import { __resetSetupActivity, noteSetupTerminalClosed, noteSetupTerminalOpened } from "@/lib/terminal/setup-activity";

let root: string;
let claudeDir: string;
let codexHome: string;
let envSnapshot: NodeJS.ProcessEnv;

const claudeJson = () => path.join(claudeDir, ".claude.json");
const FAL = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer test-key" } };

/** Writes and moves the modified time forward, so a rewrite within the same millisecond still reads as a change. */
let tick = 0;
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const at = new Date(Date.now() + ++tick * 1000);
  fs.utimesSync(file, at, at);
}

beforeEach(() => {
  envSnapshot = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-standby-freshness-"));
  claudeDir = path.join(root, "claude");
  codexHome = path.join(root, "codex");
  h.agentDir = path.join(root, "agent");
  for (const dir of [claudeDir, codexHome, h.agentDir]) fs.mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexHome;
  __resetSetupActivity();
});

afterEach(() => {
  process.env = envSnapshot;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("staleStandbyReason — Claude Code", () => {
  it("a standby is current while nothing it reads has changed", () => {
    const none = captureStandbyFreshness("claude-code");
    expect(staleStandbyReason("claude-code", none)).toBeNull();
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    const created = captureStandbyFreshness("claude-code");
    expect(staleStandbyReason("claude-code", created)).toBeNull();
  });

  it("a provider added to the user-scope MCP servers after the standby was created makes it stale", () => {
    write(claudeJson(), { numStartups: 3, mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" } } });
    const created = captureStandbyFreshness("claude-code");
    write(claudeJson(), { numStartups: 3, mcpServers: { libi: { type: "http", url: "http://127.0.0.1:3457/mcp" }, "fal-ai": FAL } });
    expect(staleStandbyReason("claude-code", created)).toBe("mcp_config_changed");
  });

  it("what Claude Code writes on its own never makes a standby stale: counters, other projects, a first .claude.json, an empty project entry", () => {
    const beforeAnyConfig = captureStandbyFreshness("claude-code");
    write(claudeJson(), { numStartups: 1, projects: { [h.agentDir]: { mcpServers: {}, enabledMcpjsonServers: [], lastSessionId: "a" } } });
    expect(staleStandbyReason("claude-code", beforeAnyConfig)).toBeNull();

    write(claudeJson(), { numStartups: 3, mcpServers: { "fal-ai": FAL }, projects: { "/elsewhere": { mcpServers: {} } } });
    const created = captureStandbyFreshness("claude-code");
    write(claudeJson(), { numStartups: 4, tipsHistory: { x: 1 }, mcpServers: { "fal-ai": FAL }, projects: { "/elsewhere": { mcpServers: { other: FAL } } } });
    expect(staleStandbyReason("claude-code", created)).toBeNull();
  });

  it("the in-app project's own MCP servers and switches count, keyed by the agent folder with either slash", () => {
    write(claudeJson(), { projects: { [h.agentDir]: { mcpServers: {} } } });
    const created = captureStandbyFreshness("claude-code");
    write(claudeJson(), { projects: { [h.agentDir]: { mcpServers: { "fal-ai": FAL } } } });
    expect(staleStandbyReason("claude-code", created)).toBe("mcp_config_changed");

    const beforeToggle = captureStandbyFreshness("claude-code");
    write(claudeJson(), { projects: { [h.agentDir]: { mcpServers: { "fal-ai": FAL }, disabledMcpServers: ["fal-ai"] } } });
    expect(staleStandbyReason("claude-code", beforeToggle)).toBe("mcp_config_changed");

    h.agentDir = "C:\\Users\\someone\\AppData\\Roaming\\libi\\agent";
    write(claudeJson(), { projects: { "C:/Users/someone/AppData/Roaming/libi/agent": { mcpServers: {} } } });
    const onWindows = captureStandbyFreshness("claude-code");
    write(claudeJson(), { projects: { "C:/Users/someone/AppData/Roaming/libi/agent": { mcpServers: { "fal-ai": FAL } } } });
    expect(staleStandbyReason("claude-code", onWindows)).toBe("mcp_config_changed");
  });

  it("the agent folder's .mcp.json and the server switches in the agent folder's settings count", () => {
    const created = captureStandbyFreshness("claude-code");
    write(path.join(h.agentDir, ".mcp.json"), { mcpServers: { "fal-ai": FAL } });
    expect(staleStandbyReason("claude-code", created)).toBe("mcp_config_changed");

    const beforeLocal = captureStandbyFreshness("claude-code");
    write(path.join(h.agentDir, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["fal-ai"] });
    expect(staleStandbyReason("claude-code", beforeLocal)).toBe("mcp_config_changed");

    const beforeOther = captureStandbyFreshness("claude-code");
    write(path.join(h.agentDir, ".claude", "settings.json"), { permissions: { allow: ["Bash"] } });
    expect(staleStandbyReason("claude-code", beforeOther)).toBeNull();
  });

  it("without CLAUDE_CONFIG_DIR it reads ~/.claude.json and ~/.claude/settings.json", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const created = captureStandbyFreshness("claude-code");
    write(path.join(home, ".claude.json"), { mcpServers: { "fal-ai": FAL } });
    expect(staleStandbyReason("claude-code", created)).toBe("mcp_config_changed");

    const beforeSettings = captureStandbyFreshness("claude-code");
    write(path.join(home, ".claude", "settings.json"), { enableAllProjectMcpServers: true });
    expect(staleStandbyReason("claude-code", beforeSettings)).toBe("mcp_config_changed");
  });

  it("a token refresh in .credentials.json never makes a standby stale", () => {
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    const created = captureStandbyFreshness("claude-code");
    write(path.join(claudeDir, ".credentials.json"), { claudeAiOauth: { accessToken: "refreshed" } });
    expect(staleStandbyReason("claude-code", created)).toBeNull();
  });

  it("a .claude.json caught mid-write reads as a change — a chat started fresh costs a moment, one missing a provider costs the provider — and a complete one is read again", () => {
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    const created = captureStandbyFreshness("claude-code");
    write(claudeJson(), '{"mcpServers": {"fal-');
    expect(staleStandbyReason("claude-code", created)).toBe("mcp_config_changed");
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    expect(staleStandbyReason("claude-code", created)).toBeNull();
  });

  it("Codex's config is not Claude Code's: a changed config.toml leaves a Claude standby current", () => {
    const created = captureStandbyFreshness("claude-code");
    write(path.join(codexHome, "config.toml"), '[mcp_servers.fal-ai]\nurl = "https://mcp.fal.ai/mcp"\n');
    expect(staleStandbyReason("claude-code", created)).toBeNull();
  });
});

describe("staleStandbyReason — Codex", () => {
  it("a changed config.toml in its home or in the agent folder's .codex makes a Codex standby stale; Claude Code's config does not", () => {
    write(path.join(codexHome, "config.toml"), "");
    const created = captureStandbyFreshness("codex");
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    expect(staleStandbyReason("codex", created)).toBeNull();
    write(path.join(codexHome, "config.toml"), '[mcp_servers.fal-ai]\nurl = "https://mcp.fal.ai/mcp"\n');
    expect(staleStandbyReason("codex", created)).toBe("mcp_config_changed");

    const beforeProject = captureStandbyFreshness("codex");
    write(path.join(h.agentDir, ".codex", "config.toml"), '[mcp_servers.other]\nurl = "https://example.com/mcp"\n');
    expect(staleStandbyReason("codex", beforeProject)).toBe("mcp_config_changed");
  });
});

describe("staleStandbyReason — setup terminals", () => {
  it("a setup terminal opened after the standby was created makes it stale, even once it closed", () => {
    const created = captureStandbyFreshness("claude-code");
    noteSetupTerminalOpened();
    expect(staleStandbyReason("claude-code", created)).toBe("setup_terminal");
    noteSetupTerminalClosed();
    expect(staleStandbyReason("claude-code", created)).toBe("setup_terminal");
  });

  it("a standby created while a setup terminal was open stays stale after it closes; one created after that is current", () => {
    noteSetupTerminalOpened();
    const duringSetup = captureStandbyFreshness("codex");
    expect(staleStandbyReason("codex", duringSetup)).toBe("setup_terminal");
    noteSetupTerminalClosed();
    const afterSetup = captureStandbyFreshness("codex");
    expect(staleStandbyReason("codex", duringSetup)).toBe("setup_terminal");
    expect(staleStandbyReason("codex", afterSetup)).toBeNull();
  });

  it("keeps only digests: no key from the config appears in what is captured", () => {
    write(claudeJson(), { mcpServers: { "fal-ai": FAL } });
    expect(JSON.stringify(captureStandbyFreshness("claude-code"))).not.toContain("test-key");
  });
});
