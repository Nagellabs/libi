import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("AgentProcessManager spawn env", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it("sets MCP_TIMEOUT=60000 on the spawned agent process", async () => {
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
    expect(opts.env.MCP_TIMEOUT).toBe("60000");
    expect(opts.env.PATH).toBe(process.env.PATH);
  });
});
