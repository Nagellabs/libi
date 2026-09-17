import { describe, it, expect, vi, beforeEach } from "vitest";

const sync = vi.fn<(reason: string) => Promise<void>>(async () => {});
const dialects = vi.fn(() => [".claude/skills", ".agents/skills"] as readonly string[]);
const USER_ROOTS = ["/home/me/.claude/skills", "/home/me/.agents/skills"];
vi.mock("@/mcp/skills/installs", () => ({
  syncSkillInstalls: (reason: string) => sync(reason),
  ownAgentDirWriteOptions: () => ({ dialects: dialects(), protectedRoots: USER_ROOTS }),
}));
const write = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/mcp/skills/writer", async (orig) => ({
  ...(await orig<typeof import("@/mcp/skills/writer")>()),
  writeSkillsToWorkspace: (...a: unknown[]) => write(...a),
}));
vi.mock("@/mcp/skills/loader", () => ({ loadEnabledSkills: async () => [] }));
vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getLibiAgentDir: () => "/agent" }));

import { serverLogger } from "@/lib/logger";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { prepareAgentDir } from "@/mcp/workspace";

beforeEach(() => {
  sync.mockClear();
  write.mockClear();
  dialects.mockReturnValue([".claude/skills"]);
});

describe("skill-change trigger", () => {
  it("writes libi's own dir with the current dialect set, then re-syncs every recorded install", async () => {
    await syncSkillsToWorkspace();
    expect(write).toHaveBeenCalledWith("/agent", [], { dialects: [".claude/skills"], protectedRoots: USER_ROOTS });
    expect(sync).toHaveBeenCalledWith("skills-changed");
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]);
  });
  it("a failing install sync never fails the skill change", async () => {
    const error = vi.spyOn(serverLogger, "error");
    const failure = Object.assign(new Error("EACCES: permission denied, open '/Users/me/private-project/.claude/skills'"), { code: "EACCES" });
    sync.mockRejectedValueOnce(failure);
    try {
      await expect(syncSkillsToWorkspace()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "skills", op: "installs_sync_after_change_failed", err: { code: "EACCES", name: "Error" } }),
        expect.any(String),
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe("boot: prepareAgentDir", () => {
  it("writes libi's own dir with the current dialect set and does not sync installs itself", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-"));
    await prepareAgentDir(dir);
    expect(write).toHaveBeenCalledWith(dir, [], { dialects: [".claude/skills"], protectedRoots: USER_ROOTS });
    expect(sync).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
