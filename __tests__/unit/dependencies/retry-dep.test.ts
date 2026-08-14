import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("child_process", () => ({
  execSync: vi.fn(() => { throw new Error("not on PATH"); }),
  execFile: vi.fn((_c: string, _a: string[], cb?: (e: Error | null) => void) => cb?.(null)),
}));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn() },
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

import { getDb } from "@/lib/db/client";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { seedDatabase } from "@/lib/db/init";

describe("DependencyManager.retryDep", () => {
  beforeEach(() => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
  });

  it("marks a dep as failed when retry's download throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("retry net down"));
    const manager = new DependencyManager();
    await expect(manager.retryDep("libi", "ffmpeg")).rejects.toThrow();

    const db = vi.mocked(getDb)();
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi")).all()[0];
    const list = JSON.parse(row.dependencyStatus!) as Array<{
      binary: string;
      runtimeStatus: string;
      error?: string | null;
    }>;
    const ffmpeg = list.find((e) => e.binary === "ffmpeg");
    expect(ffmpeg?.runtimeStatus).toBe("failed");
    expect(ffmpeg?.error).toMatch(/retry net down/);
  });

  it("throws for unknown mcpId", async () => {
    const manager = new DependencyManager();
    await expect(manager.retryDep("does-not-exist", "ffmpeg")).rejects.toThrow(/No bundled MCP/);
  });

  it("throws for unknown binary", async () => {
    const manager = new DependencyManager();
    await expect(manager.retryDep("libi", "not-a-real-binary")).rejects.toThrow(/No dep/);
  });

  it("marks dep failed when install path completes but binary still missing", async () => {
    // The download path completes without throwing, but fs.existsSync stays false
    // so the post-install resolveStatusAsync returns installed: false.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(8), { status: 200 }),
    );
    const manager = new DependencyManager();
    // May or may not throw depending on whether archive extraction fails;
    // either way the dep should NOT be left stuck in "pending" or "installing".
    await manager.retryDep("libi", "ffmpeg").catch(() => { /* swallow */ });

    const db = vi.mocked(getDb)();
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi")).all()[0];
    const list = JSON.parse(row.dependencyStatus!) as Array<{
      binary: string;
      runtimeStatus: string;
      error?: string | null;
    }>;
    const ffmpeg = list.find((e) => e.binary === "ffmpeg");
    expect(ffmpeg?.runtimeStatus).toBe("failed");
  });
});
