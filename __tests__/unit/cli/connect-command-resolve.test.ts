/**
 * `libi connect` is a one-shot process: when it looks for the user's
 * `claude` and `codex` it must hold the event loop until the answer arrives.
 * Without that the unref'd login-shell probe let Node exit mid-resolution and
 * the command silently did nothing (live QA, 2026-09-12). The hold itself is
 * proven in `__tests__/unit/agents/cli/resolve-hold-event-loop.test.ts`; this
 * pins that the CLI asks for it, for both agents.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgentCli: vi.fn(async () => null),
  addSkillInstall: vi.fn(),
  listSkillInstalls: vi.fn(async () => []),
  trackServerEvent: vi.fn(),
}));
vi.mock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: mocks.resolveAgentCli }));
vi.mock("@/mcp/skills/installs", () => ({
  addSkillInstall: mocks.addSkillInstall,
  listSkillInstalls: mocks.listSkillInstalls,
}));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: mocks.trackServerEvent }));
vi.mock("@/lib/cli/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cli/connect")>();
  return {
    ...actual,
    // Only the lookups are under test: call both finders, decide nothing else.
    runConnect: vi.fn(async (_input: unknown, deps: { findClaude(): Promise<unknown>; findCodex(): Promise<unknown> }) => {
      await deps.findClaude();
      await deps.findCodex();
      return [];
    }),
  };
});

import { connectCommand } from "@/lib/cli/connect-command";

describe("connectCommand's CLI lookups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolve claude and codex with holdEventLoop, so the process waits for the login-shell probe", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await connectCommand("/tmp/libi-connect-resolve-test", {});
    } finally {
      stdout.mockRestore();
    }
    expect(mocks.resolveAgentCli).toHaveBeenCalledWith("claude-code", expect.objectContaining({ holdEventLoop: true }));
    expect(mocks.resolveAgentCli).toHaveBeenCalledWith("codex", expect.objectContaining({ holdEventLoop: true }));
  });
});
