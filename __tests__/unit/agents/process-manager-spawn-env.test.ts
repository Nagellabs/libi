import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Capture spawn calls
const spawnMock = vi.fn(() => ({
  on: vi.fn(),
  stdin: { write: vi.fn() },
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  kill: vi.fn(),
  pid: 12345,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));

type Adapter = { installed: boolean; command?: string; args?: string[]; unavailableReason?: unknown } | undefined;
const ADAPTER: Adapter = { installed: true, command: "/fake/claude-agent-acp", args: ["--mode", "stdio"] };
let adapter: Adapter = ADAPTER;
vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: () => adapter,
}));

const USABLE = { path: "/u/bin/claude", realPath: "/u/real/claude", execPath: "/u/real/claude", version: "9.0.0", meetsMinimum: true };
let resolved: unknown = USABLE;
const resolveCalls: Array<[string, unknown]> = [];
vi.mock("@/lib/agents/cli/resolve", () => ({
  resolveAgentCli: async (agentId: string, deps?: unknown) => {
    resolveCalls.push([agentId, deps]);
    return resolved;
  },
  isUsableCli: (r: { meetsMinimum?: boolean } | null) => !!r && "meetsMinimum" in r && r.meetsMinimum === true,
}));

/** Spawn an agent and return the options object the child was actually given. */
async function spawnOpts(agentId = "claude-code"): Promise<Record<string, unknown>> {
  const { AgentProcessManager } = await import("@/lib/agents/process-manager");
  const pm = new AgentProcessManager();
  try {
    await pm.warmProcess(agentId);
  } catch {
    // We don't care about post-spawn wiring failing — only spawn args
  }
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [, , opts] = spawnMock.mock.calls[0];
  expect(opts).toBeDefined();
  return opts as Record<string, unknown>;
}

/** Spawn an agent and return the env the child was actually given. */
async function spawnEnv(agentId = "claude-code"): Promise<Record<string, string>> {
  const opts = await spawnOpts(agentId);
  expect(opts.env).toBeDefined();
  return opts.env as Record<string, string>;
}

describe("AgentProcessManager spawn env", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    resolved = USABLE;
    adapter = ADAPTER;
    resolveCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets MCP_TIMEOUT=60000 on the spawned agent process", async () => {
    const env = await spawnEnv();
    expect(env.MCP_TIMEOUT).toBe("60000");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("does not pass the host Claude Code session's markers to the agent (they would mark it a child session)", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "host");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/keep/me");
    const env = await spawnEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/keep/me");
    expect(env.MCP_TIMEOUT).toBe("60000");
  });

  // The agent reaches libi through the HTTP aggregator's URL, never through an
  // inherited port. What its shell starts is the user's, like the terminal: a
  // stdio libi MCP pointed at another home must find that home's server.
  it("does not pass this server's LIBI_SERVER_PORT to the agent, so a libi MCP its shell starts finds its own home's server", async () => {
    vi.stubEnv("LIBI_SERVER_PORT", "55303");
    const env = await spawnEnv();
    expect(env).not.toHaveProperty("LIBI_SERVER_PORT");
    expect(env.MCP_TIMEOUT).toBe("60000");
  });

  // Windows allocates a fresh console for a console-subsystem child of a
  // console-less parent, and Electron's main process is exactly that. Without
  // this flag, opening Claude Code or Codex in the packaged Windows app raised
  // an empty Windows Terminal window titled with libi's node path, which then
  // sat there for the whole session (observed on the QA box, 2026-08-23).
  // Inert off Windows, so only this assertion can keep it from being dropped.
  it("hides the child's console window, which Windows would otherwise open", async () => {
    const opts = await spawnOpts();
    expect(opts.windowsHide).toBe(true);
  });

  // The ACP child and the built-in Terminal's PTY (lib/terminal/manager.ts,
  // covered by __tests__/unit/terminal/manager.test.ts) must name the SAME
  // codex home. They used to disagree: the PTY passed `resolveCodexHome()`
  // while this child passed nothing, so codex fell back to `~/.codex`. On a
  // canonical install those coincide and nothing looked wrong — the divergence
  // only appeared where it does the most damage, on the non-canonical
  // instances (worktree / skill-eval / test mode) libi is VERIFIED with.
  describe("CODEX_HOME parity with the terminal", () => {
    // A scratch HOME for the cases that resolve to `~/.codex`, so the spawn's
    // `ensureCodexHome()` can never name or create the real one.
    async function envWithScratchHome(libiHome: string): Promise<{ env: Record<string, string>; home: string }> {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-spawn-home-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("LIBI_HOME", libiHome);
      vi.stubEnv("CODEX_HOME", "");
      vi.stubEnv("LIBI_TEST_MODE", "");
      try {
        return { env: await spawnEnv(), home };
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    it("names the user's ~/.codex on the installed app", async () => {
      const { env, home } = await envWithScratchHome("");
      expect(env.CODEX_HOME).toBe(path.join(home, ".codex"));
    });

    it("names the user's ~/.codex from a git worktree too, so the chat reads the config the user's own Codex reads", async () => {
      const { env, home } = await envWithScratchHome("/tmp/libi-worktree-home");
      expect(env.CODEX_HOME).toBe(path.join(home, ".codex"));
      expect(env.CODEX_HOME).not.toBe(path.join("/tmp/libi-worktree-home", ".codex"));
    });

    it("scopes it in test mode too, so a skill-eval run cannot read the real Codex config", async () => {
      vi.stubEnv("LIBI_HOME", "/tmp/libi-eval-home");
      vi.stubEnv("LIBI_TEST_MODE", "1");
      vi.stubEnv("CODEX_HOME", "");
      const env = await spawnEnv();
      expect(env.CODEX_HOME).toBe(path.join("/tmp/libi-eval-home", ".codex"));
    });

    it("lets an explicit CODEX_HOME win, mirroring the Codex CLI's own rule", async () => {
      vi.stubEnv("CODEX_HOME", "/tmp/explicit-codex");
      vi.stubEnv("LIBI_HOME", "/tmp/libi-worktree-home");
      const env = await spawnEnv();
      expect(env.CODEX_HOME).toBe("/tmp/explicit-codex");
    });

    // Naming the home is only half of it. Codex exits 1 when CODEX_HOME points
    // at a directory that isn't there, so a scoped home that no install has
    // touched yet must be created BEFORE the child starts — the live failure
    // this test pins: "Codex process has exited with code 1: … CODEX_HOME
    // points to … but that path does not exist".
    it("creates the scoped test-mode home before spawning, so codex can actually start", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-spawn-codex-"));
      try {
        vi.stubEnv("CODEX_HOME", "");
        vi.stubEnv("LIBI_HOME", root);
        vi.stubEnv("LIBI_TEST_MODE", "1");
        const env = await spawnEnv();
        expect(env.CODEX_HOME).toBe(path.join(root, ".codex"));
        expect(fs.existsSync(env.CODEX_HOME)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("the user's own CLI is what the adapter execs", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    resolved = USABLE;
    adapter = ADAPTER;
    resolveCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets CLAUDE_CODE_EXECUTABLE to the resolved execPath for claude-code, overriding an inherited value", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/stale/claude");
    const env = await spawnEnv("claude-code");
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/u/real/claude");
  });

  it("sets CODEX_PATH for codex", async () => {
    resolved = { ...USABLE, execPath: "/u/real/codex" };
    expect((await spawnEnv("codex")).CODEX_PATH).toBe("/u/real/codex");
  });

  it("resolves the CLI with staleOk, so a spawn never waits on the login-shell probe once a memo exists", async () => {
    await spawnEnv("codex");
    expect(resolveCalls).toEqual([["codex", { staleOk: true }]]);
  });

  it("refuses to spawn when no usable CLI resolves — a typed refusal carrying the CLI's reason for null, broken, or below the minimum", async () => {
    const { AgentProcessManager } = await import("@/lib/agents/process-manager");
    const { AgentSpawnRefusedError } = await import("@/lib/agents/spawn-refused-error");
    const cases: Array<[unknown, object]> = [
      [null, { code: "not_installed", message: "Codex isn't set up yet — open Agents to install it." }],
      [{ foundButBroken: true, path: "/x" }, { code: "install_failed", message: "Codex was found at /x but won't run — open Agents.", detail: "found but won't run" }],
      [{ ...USABLE, version: "1.0.0", meetsMinimum: false }, { code: "not_installed", message: "Codex 1.0.0 is older than libi needs — open Agents to update it.", detail: "below minimum" }],
    ];
    for (const [r, reason] of cases) {
      resolved = r;
      const err = await new AgentProcessManager().warmProcess("codex").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AgentSpawnRefusedError);
      expect((err as InstanceType<typeof AgentSpawnRefusedError>).agentId).toBe("codex");
      expect((err as InstanceType<typeof AgentSpawnRefusedError>).reason).toEqual(reason);
      expect((err as Error).message).toMatch(/^Agent codex is not installed: .*Agents/);
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing adapter with the same typed error, carrying detection's reason — and never resolves a CLI for it", async () => {
    const { AgentProcessManager } = await import("@/lib/agents/process-manager");
    const { AgentSpawnRefusedError } = await import("@/lib/agents/spawn-refused-error");
    const reason = { code: "not_installed", message: "Codex support isn't downloaded yet — set it up in Agents." };
    adapter = { installed: false, unavailableReason: reason };
    const err = await new AgentProcessManager().warmProcess("codex").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnRefusedError);
    expect((err as InstanceType<typeof AgentSpawnRefusedError>).reason).toEqual(reason);
    expect((err as Error).message).toBe("Agent codex is not installed: Codex support isn't downloaded yet — set it up in Agents.");
    expect(resolveCalls).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a missing adapter detection gave no reason for still refuses with a typed error that points at Agents", async () => {
    const { AgentProcessManager } = await import("@/lib/agents/process-manager");
    const { AgentSpawnRefusedError } = await import("@/lib/agents/spawn-refused-error");
    adapter = undefined;
    const err = await new AgentProcessManager().warmProcess("claude-code").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnRefusedError);
    expect((err as InstanceType<typeof AgentSpawnRefusedError>).reason).toEqual({
      code: "not_installed",
      message: "Claude Code isn't set up yet — open Agents to install it.",
    });
  });

  it("an agent without a setup declaration gets no CLI resolution and no CLI env", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
    vi.stubEnv("CODEX_PATH", "");
    const env = await spawnEnv("some-other-agent");
    expect(resolveCalls).toEqual([]);
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("");
    expect(env.CODEX_PATH).toBe("");
  });
});
