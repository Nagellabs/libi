/**
 * Unit: DependencyManager.getStatuses + ensureAll aggregation.
 *
 * Mocks the bundled registry and the filesystem so we exercise the
 * multi-dep path without downloading anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let tempBinDir: string;
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getLibiBinDir: () => tempBinDir,
  };
});

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

// Stub the bundled registry so we don't invoke real downloads.
vi.mock("@/mcp/registry/bundled", () => ({
  BUNDLED_MCP_SERVERS: [
    {
      id: "libi",
      name: "Libi",
      description: "test",
      npmUrl: null,
      type: "stdio",
      command: "",
      args: [],
      requireApproval: false,
      core: true,
      dependencies: [
        {
          binary: "fake-a",
          downloadUrl: { darwin: "x", linux: "x", win32: "x" },
        },
        {
          binary: "fake-b",
          downloadUrl: { darwin: "x", linux: "x", win32: "x" },
        },
      ],
    },
  ],
}));

// Block PATH lookups so filesystem is the sole source of truth.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, opts?: unknown) => {
      if (/^(which|where)\s/.test(cmd)) {
        throw new Error("blocked for test");
      }
      return actual.execSync(cmd, opts as never);
    },
  };
});

import { DependencyManager } from "@/mcp/registry/dependency-manager";

const MCP_ID = "libi";

function touchBundled(name: string): void {
  const exeName = process.platform === "win32" ? `${name}.exe` : name;
  fs.writeFileSync(path.join(tempBinDir, exeName), Buffer.from([0]));
}

function seedRow(): void {
  testDb
    .insert(mcpServers)
    .values({
      id: MCP_ID,
      name: "Libi",
      description: "",
      type: "stdio",
      command: "",
      args: JSON.stringify([]),
      bundled: true,
      enabled: true,
      requireApproval: false,
      installStatus: "pending",
    })
    .run();
}

describe("DependencyManager multi-dep aggregation", () => {
  beforeEach(() => {
    tempBinDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb);
    seedRow();
  });

  afterEach(() => {
    cleanupTempDir(tempBinDir);
  });

  it("getStatuses returns one entry per declared dependency", async () => {
    const mgr = new DependencyManager();
    const statuses = await mgr.getStatuses(MCP_ID);
    expect(statuses.map((s) => s.binary).sort()).toEqual(["fake-a", "fake-b"]);
  });

  it("marks the aggregate 'failed' when ONE dep is missing and the other is present", async () => {
    touchBundled("fake-a");

    const mgr = new DependencyManager();
    await mgr.ensureAll().catch(() => {});

    const [row] = testDb
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, MCP_ID))
      .limit(1)
      .all();
    expect(row.installStatus).toBe("failed");
  });

  it("marks the aggregate 'installed' when ALL deps are present", async () => {
    touchBundled("fake-a");
    touchBundled("fake-b");

    const mgr = new DependencyManager();
    await mgr.ensureAll();

    const [row] = testDb
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, MCP_ID))
      .limit(1)
      .all();
    expect(row.installStatus).toBe("installed");
  });

  it("writes dependencyStatus JSON matching the live filesystem", async () => {
    touchBundled("fake-a");
    touchBundled("fake-b");

    const mgr = new DependencyManager();
    await mgr.ensureAll();

    const [row] = testDb
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, MCP_ID))
      .limit(1)
      .all();
    expect(row.dependencyStatus).toBeTruthy();
    const parsed = JSON.parse(row.dependencyStatus!);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((d: { installed: boolean }) => d.installed)).toBe(true);
  });
});
