import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
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

// Its own LIBI_HOME, not the vitest-wide one: installs take a cross-process
// lock file next to what they write (mcp/registry/install-lock.ts), and files
// sharing one home would wait on — and be served by — each other's installs.
// `fs` is mocked above, so the home is made with the real one.
const realFs = await vi.importActual<typeof import("fs")>("fs");
const savedHome = process.env.LIBI_HOME;
let home: string;
beforeEach(() => {
  home = realFs.mkdtempSync(path.join(os.tmpdir(), "libi-dep-test-"));
  realFs.mkdirSync(path.join(home, "bin"), { recursive: true });
  process.env.LIBI_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  realFs.rmSync(home, { recursive: true, force: true });
});

describe("per-dep runtime status JSON", () => {
  beforeEach(() => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
  });

  it("writes status entries with runtimeStatus field for each libi dep", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("net down"));
    const manager = new DependencyManager();
    await manager.ensureAll();

    const db = vi.mocked(getDb)();
    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "libi"))
      .all()[0];

    const parsed = JSON.parse(row.dependencyStatus!) as Array<{
      binary: string;
      installed: boolean;
      runtimeStatus: "pending" | "installing" | "installed" | "failed";
      error?: string | null;
    }>;
    expect(parsed.length).toBeGreaterThan(0);
    for (const s of parsed) {
      expect(typeof s.binary).toBe("string");
      expect(["pending", "installing", "installed", "failed"]).toContain(s.runtimeStatus);
    }
    expect(parsed.every((s) => s.runtimeStatus === "failed")).toBe(true);
  });

  it("emits refresh_query on mcp-servers when transitions fire", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("net down"));
    const { navigationEmitter } = await import("@/lib/navigation-events");
    const events: Array<{ queryKey: string }> = [];
    const listener = (payload: { queryKey: string }) => events.push(payload);
    navigationEmitter.on("refresh_query", listener);

    try {
      const manager = new DependencyManager();
      await manager.ensureAll();
    } finally {
      navigationEmitter.off("refresh_query", listener);
    }

    // ensureAll runs writeDepTransition many times (installing → failed for
    // each dep). At least one event should have queryKey "mcp-servers".
    const mcpEvents = events.filter((e) => e.queryKey === "mcp-servers");
    expect(mcpEvents.length).toBeGreaterThan(0);
  });
});
