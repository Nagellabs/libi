import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { invalidateMcpConfig, buildLibiEntry } from "@/lib/mcp-config";

// The libi MCP child must resolve the SAME LIBI_HOME as the Next process that
// spawned it. claude-agent-acp propagates the parent env so an unset entry env
// worked for Claude; codex-acp SANITIZES the child env, so without an explicit
// LIBI_HOME the child fell back to the default ~/.libi and wrote a
// worktree/dev session's pieces into the canonical home. buildLibiEntry must
// therefore pin the spawn env (LIBI_HOME included) like every other entry.
describe("buildLibiEntry — LIBI_HOME is pinned", () => {
  beforeEach(() => {
    createTestDb();
    invalidateMcpConfig();
  });
  afterEach(() => {
    resetTestDb();
    invalidateMcpConfig();
    vi.unstubAllEnvs();
  });

  it("buildLibiEntry carries an env that includes the process LIBI_HOME", () => {
    vi.stubEnv("LIBI_HOME", "/tmp/libi-worktree-home");
    const entry = buildLibiEntry() as { command: string; env?: Record<string, string> };
    expect(entry.env).toBeDefined();
    expect(entry.env?.LIBI_HOME).toBe("/tmp/libi-worktree-home");
  });
});
