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

vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: () => ({
    installed: true,
    command: "/fake/claude-agent-acp",
    args: ["--mode", "stdio"],
  }),
}));

/** Spawn an agent and return the env the child was actually given. */
async function spawnEnv(): Promise<Record<string, string>> {
  const { AgentProcessManager } = await import("@/lib/agents/process-manager");
  const pm = new AgentProcessManager();
  try {
    await pm.warmProcess("claude-code");
  } catch {
    // We don't care about post-spawn wiring failing — only spawn args
  }
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [, , opts] = spawnMock.mock.calls[0];
  expect(opts.env).toBeDefined();
  return opts.env;
}

describe("AgentProcessManager spawn env", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets MCP_TIMEOUT=60000 on the spawned agent process", async () => {
    const env = await spawnEnv();
    expect(env.MCP_TIMEOUT).toBe("60000");
    expect(env.PATH).toBe(process.env.PATH);
  });

  // The ACP child and the built-in Terminal's PTY (lib/terminal/manager.ts,
  // covered by __tests__/unit/terminal/manager.test.ts) must name the SAME
  // codex home. They used to disagree: the PTY passed `resolveCodexHome()`
  // while this child passed nothing, so codex fell back to `~/.codex`. On a
  // canonical install those coincide and nothing looked wrong — the divergence
  // only appeared where it does the most damage, on the non-canonical
  // instances (worktree / skill-eval / test mode) libi is VERIFIED with.
  describe("CODEX_HOME parity with the terminal", () => {
    it("names the user's real ~/.codex on a canonical instance", async () => {
      vi.stubEnv("LIBI_HOME", "");
      vi.stubEnv("CODEX_HOME", "");
      vi.stubEnv("LIBI_TEST_MODE", "");
      const env = await spawnEnv();
      expect(env.CODEX_HOME).toBe(path.join(os.homedir(), ".codex"));
    });

    it("scopes it under LIBI_HOME for a non-canonical instance — never the user's real one", async () => {
      vi.stubEnv("LIBI_HOME", "/tmp/libi-worktree-home");
      vi.stubEnv("CODEX_HOME", "");
      const env = await spawnEnv();
      expect(env.CODEX_HOME).toBe(path.join("/tmp/libi-worktree-home", ".codex"));
      expect(env.CODEX_HOME).not.toBe(path.join(os.homedir(), ".codex"));
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
    it("creates the scoped home before spawning, so codex can actually start", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-spawn-codex-"));
      try {
        vi.stubEnv("CODEX_HOME", "");
        vi.stubEnv("LIBI_HOME", root);
        const env = await spawnEnv();
        expect(env.CODEX_HOME).toBe(path.join(root, ".codex"));
        expect(fs.existsSync(env.CODEX_HOME)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
