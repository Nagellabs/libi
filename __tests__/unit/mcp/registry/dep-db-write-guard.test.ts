import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The "no DB writes before migrations have run" invariant, and the aggregate
 * guard that used to sit beside it.
 *
 * Category A runs in the CLI parent BEFORE Category B migrates, so a write
 * from that process targets a schemaless database. The guard used to be a
 * `private skipDbWrites` field on `DependencyManager`, while the write itself
 * lives in `mcp/registry/dep-transition.ts` — a leaf shared with
 * `lib/export/ensure-chromium.ts`, which cannot see instance state. The
 * invariant was therefore documented in a header comment and enforced on
 * exactly one of the two paths into it.
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { eq } from "drizzle-orm";
import { createTestDb } from "../../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import {
  depDbWritesSuppressed,
  setDepDbWritesSuppressed,
  writeDepTransition,
} from "@/mcp/registry/dep-transition";

beforeEach(() => {
  vi.mocked(getDb).mockReset();
  setDepDbWritesSuppressed(false);
});

afterEach(() => {
  setDepDbWritesSuppressed(false);
});

describe("writeDepTransition's own suppression guard", () => {
  it("does not even open the database while writes are suppressed", () => {
    setDepDbWritesSuppressed(true);
    // `getDb` is left un-stubbed on purpose: reaching for it at all throws,
    // which is a sharper assertion than counting calls.
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("getDb() must not be called while DB writes are suppressed");
    });

    expect(() =>
      writeDepTransition("libi-export", "chromium", { runtimeStatus: "installing" }),
    ).not.toThrow();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("writes normally once suppression is lifted", () => {
    const run = vi.fn();
    const where = vi.fn(() => ({ run }));
    const set = vi.fn(() => ({ where }));
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              all: () => [{ id: "libi-export", dependencyStatus: "[]" }],
            }),
          }),
        }),
      }),
      update: () => ({ set }),
    } as never);

    writeDepTransition("libi-export", "chromium", { runtimeStatus: "installing" });

    expect(getDb).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  it("is the SAME flag DependencyManager.setSkipDbWrites sets — not a second copy", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const dm = new DependencyManager();

    expect(depDbWritesSuppressed()).toBe(false);
    dm.setSkipDbWrites(true);
    expect(depDbWritesSuppressed()).toBe(true);

    // …and the leaf write is suppressed by it, which is the point: a future
    // Category A caller reaching `writeDepTransition` any other way — a new
    // installer, ensure-chromium, a job runner — is covered too.
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("getDb() must not be called while DB writes are suppressed");
    });
    expect(() =>
      writeDepTransition("libi-export", "chromium", { runtimeStatus: "failed" }),
    ).not.toThrow();

    dm.setSkipDbWrites(false);
    expect(depDbWritesSuppressed()).toBe(false);
  });
});

describe("settleInstallStatus's aggregate guard", () => {
  it("converges a row left at 'installing' instead of pinning it forever", async () => {
    // `installing` is a per-DEP `runtimeStatus`, never an aggregate
    // `installStatus` — it is not even a member of `InstallStatus`, and the
    // old `row.installStatus === "installing"` early return sat behind an
    // `as InstallStatus` cast that stopped the compiler saying so. Written
    // here by hand (the column is TEXT) to prove the recompute is reached:
    // had the branch been real, a crash mid-download would have parked the
    // Settings badge on a spinner for every subsequent boot.
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const def = BUNDLED_MCP_SERVERS.find((d) => !d.core)!;

    db.insert(mcpServers)
      .values({
        id: def.id,
        name: def.name,
        description: def.description ?? "",
        type: def.type,
        installStatus: "installing" as never,
        dependencyStatus: "[]",
      })
      .run();

    const dm = new DependencyManager();
    const settled = await dm.settleInstallStatus(def.id);

    expect(settled).not.toBe("installing");
    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, def.id)).limit(1).all();
    expect(row!.installStatus).toBe(settled);
  });

  it("still preserves a row parked at 'failed' — that one is a real attempt", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const def = BUNDLED_MCP_SERVERS.find((d) => !d.core)!;

    db.insert(mcpServers)
      .values({
        id: def.id,
        name: def.name,
        description: def.description ?? "",
        type: def.type,
        installStatus: "failed",
        installError: "ETIMEDOUT",
        dependencyStatus: "[]",
      })
      .run();

    const dm = new DependencyManager();
    expect(await dm.settleInstallStatus(def.id)).toBe("failed");
    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, def.id)).limit(1).all();
    expect(row!.installError).toBe("ETIMEDOUT");
  });
});
