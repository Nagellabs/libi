/**
 * Integration: DependencyManager install + pre-warm probes the server.
 *
 * After the install/probe split (May 2026), `ensureMcp` only settles install
 * state; the probe lives in `prewarmMcp` (and `prewarmBundledMcps` for the
 * batch). Tests drive both phases sequentially against synthetic stubs.
 *
 * We verify:
 *  1. OK stub → after install + prewarm: serverStatus "up", serverError null.
 *  2. Crash stub → after install + prewarm: serverStatus "down", serverError contains "crash".
 *  3. deps-failed path → install marks serverStatus "down" (prewarm should skip).
 *  4. core entry (libi) → ensureMcp settles install, prewarmMcp skips the probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Mock the DB singleton so DependencyManager uses our in-memory DB ──────────
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

// ── Mock getLibiBinDir so it never touches the real filesystem ─────────────────
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getLibiBinDir: () => "/tmp/libi-test-bin-probe",
  };
});

// ── Mock child_process.execSync for "which/where" so PATH checks are no-ops ───
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      if (typeof cmd === "string" && /^(which|where)\s/.test(cmd)) {
        throw new Error("not found");
      }
      return (actual.execSync as unknown as (...args: unknown[]) => Buffer)(cmd, ...rest);
    },
  };
});

import { getDb } from "@/lib/db/client";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import type { BundledMcpDef } from "@/mcp/registry/types";

const STUB_OK = path.resolve(__dirname, "../helpers/mcp-stub-ok.js");
const STUB_CRASH = path.resolve(__dirname, "../helpers/mcp-stub-crash.js");

/** A synthetic def with no dependencies → install path goes to "not_required" then probe. */
function makeDef(overrides: Partial<BundledMcpDef> & { id: string }): BundledMcpDef {
  return {
    name: overrides.id,
    description: "test stub",
    npmUrl: null,
    type: "stdio",
    command: "node",
    args: [STUB_OK],
    requireApproval: false,
    dependencies: [],
    core: false,
    ...overrides,
  };
}

/** `ensureMcp` is private on DependencyManager — these tests drive the two
 *  phases (install, then prewarm) separately, so expose it structurally. */
type WithEnsureMcp = { ensureMcp(def: BundledMcpDef): Promise<void> };

let dbHandle: ReturnType<typeof createTestDb>;

beforeEach(() => {
  dbHandle = createTestDb();
  vi.mocked(getDb).mockReturnValue(dbHandle as never);
});

afterEach(() => {
  resetTestDb();
});

/** Insert a minimal mcp_servers row so DependencyManager's update() can find it. */
function seedRow(id: string) {
  dbHandle.insert(mcpServers).values({
    id,
    name: id,
    description: "test",
    npmUrl: null,
    type: "stdio",
    command: "node",
    args: JSON.stringify([]),
    enabled: true,
    requireApproval: false,
    bundled: true,
    installStatus: "pending",
  }).run();
}

/** Read the mcp_servers row and return it. */
function readRow(id: string) {
  const [row] = dbHandle.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
  return row;
}

describe("DependencyManager — install + pre-warm probe", () => {
  it("sets serverStatus=up when stub responds to initialize (OK stub, no deps)", async () => {
    seedRow("stub-ok");
    const def = makeDef({ id: "stub-ok", args: [STUB_OK] });
    const manager = new DependencyManager();
    // Phase 1: install settles to not_required (no deps).
    await (manager as unknown as WithEnsureMcp).ensureMcp(def);
    // Phase 2: explicit pre-warm probes the stub.
    await manager.prewarmMcp(def);

    const row = readRow("stub-ok");
    expect(row).toBeDefined();
    expect(row.installStatus).toBe("not_required");
    expect(row.serverStatus).toBe("up");
    expect(row.serverError).toBeNull();
    expect(row.serverLastChecked).toBeTruthy();
  }, 15_000);

  it("sets serverStatus=down and captures error when stub crashes", async () => {
    seedRow("stub-crash");
    const def = makeDef({ id: "stub-crash", args: [STUB_CRASH] });
    const manager = new DependencyManager();
    await (manager as unknown as WithEnsureMcp).ensureMcp(def);
    await manager.prewarmMcp(def);

    const row = readRow("stub-crash");
    expect(row).toBeDefined();
    expect(row.installStatus).toBe("not_required");
    expect(row.serverStatus).toBe("down");
    expect(row.serverError).toBeTruthy();
    expect(row.serverError).toContain("crash");
    expect(row.serverLastChecked).toBeTruthy();
  }, 15_000);

  it("sets serverStatus=down with install error message when deps fail (prewarm skips)", async () => {
    seedRow("stub-deps-fail");
    // Dep that cannot be found/downloaded — we give a bogus binary name and
    // a download URL that will fail fast. We also mock fetch to reject.
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network-error-test")) as unknown as typeof fetch;

    const def = makeDef({
      id: "stub-deps-fail",
      // The server command would succeed if probed (OK stub), but deps fail first.
      args: [STUB_OK],
      dependencies: [
        {
          binary: "nonexistent-binary-xyz",
          downloadUrl: {
            darwin: "https://example.invalid/download",
            linux: "https://example.invalid/download",
            win32: "https://example.invalid/download",
          },
        },
      ],
    });

    const manager = new DependencyManager();
    await (manager as unknown as WithEnsureMcp).ensureMcp(def);
    // Pre-warm must skip — install failed, no probe should run.
    const result = await manager.prewarmMcp(def);
    expect(result.skipped).toBe("install_not_ready");

    globalThis.fetch = origFetch;

    const row = readRow("stub-deps-fail");
    expect(row).toBeDefined();
    expect(row.installStatus).toBe("failed");
    expect(row.serverStatus).toBe("down");
    expect(row.serverError).toBeTruthy();
    // The error message should reference the install failure, not a probe error.
    expect(row.serverError).toContain("Dependencies not installed");
    expect(row.serverLastChecked).toBeTruthy();
  }, 15_000);

  it("skips probing for core (libi) entry — serverStatus stays at default", async () => {
    seedRow("libi");
    const def = makeDef({
      id: "libi",
      // Even if command points at OK stub, core must not be probed
      args: [STUB_OK],
      core: true,
    });

    const manager = new DependencyManager();
    await (manager as unknown as WithEnsureMcp).ensureMcp(def);
    const result = await manager.prewarmMcp(def);
    expect(result.skipped).toBe("core");

    const row = readRow("libi");
    expect(row).toBeDefined();
    // installStatus is written (not_required), but server columns are untouched
    expect(row.installStatus).toBe("not_required");
    // serverStatus should remain at the default "unknown" seeded value
    expect(row.serverStatus).toBe("unknown");
    expect(row.serverError).toBeNull();
    expect(row.serverLastChecked).toBeNull();
  }, 15_000);
});
