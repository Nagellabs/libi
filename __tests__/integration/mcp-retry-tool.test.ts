/**
 * Integration: retryMcpServer tool — re-probes a single MCP server and
 * updates its serverStatus in the DB.
 *
 * Cases covered:
 *  1. Happy path — row with "down" status, command pointing at OK stub → becomes "up".
 *  2. Failure case — row pointing at crash stub → stays "down".
 *  3. Guard: invalid mcpId → success: false with "not found" message.
 *  4. Guard: mcpId === "libi" → success: false (cannot retry core).
 *  5. Guard: installStatus === "failed" → success: false (deps not installed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Mock the DB singleton ────────────────────────────────────────────────────
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

// ── Mock getLibiBinDir so it never touches the real filesystem ──────────────
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getLibiBinDir: () => "/tmp/libi-test-bin-retry",
  };
});

// ── Mock invalidateMcpConfig so it doesn't touch the filesystem ─────────────
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: vi.fn(),
}));

import { getDb } from "@/lib/db/client";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { retryMcpServer } from "@/mcp/tools/mcp-retry-tools";

const STUB_OK = path.resolve(__dirname, "../helpers/mcp-stub-ok.js");
const STUB_CRASH = path.resolve(__dirname, "../helpers/mcp-stub-crash.js");

let dbHandle: ReturnType<typeof createTestDb>;

beforeEach(() => {
  dbHandle = createTestDb();
  vi.mocked(getDb).mockReturnValue(dbHandle as never);
  vi.mocked(invalidateMcpConfig).mockClear();
});

afterEach(() => {
  resetTestDb();
});

/** Insert an mcp_servers row with the given overrides. */
function seedRow(overrides: {
  id: string;
  command?: string;
  args?: string[];
  installStatus?: string;
  serverStatus?: string;
  bundled?: boolean;
}) {
  dbHandle.insert(mcpServers).values({
    id: overrides.id,
    name: overrides.id,
    description: "test stub",
    npmUrl: null,
    type: "stdio",
    command: overrides.command ?? "node",
    args: JSON.stringify(overrides.args ?? []),
    enabled: true,
    requireApproval: false,
    bundled: overrides.bundled ?? true,
    installStatus: overrides.installStatus ?? "installed",
    serverStatus: overrides.serverStatus ?? "down",
  }).run();
}

function readRow(id: string) {
  const [row] = dbHandle.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
  return row;
}

describe("retryMcpServer tool", () => {
  it("happy path: row with status 'down' becomes 'up' after OK stub probe", async () => {
    seedRow({ id: "stub-ok", command: "node", args: [STUB_OK], serverStatus: "down" });

    const result = await retryMcpServer({ mcpId: "stub-ok" });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      mcpId: "stub-ok",
      status: "up",
      recoveredInThisSession: false,
    });

    const row = readRow("stub-ok");
    expect(row.serverStatus).toBe("up");
    expect(row.serverError).toBeNull();
    expect(row.serverLastChecked).toBeTruthy();

    // Cache should be invalidated on success
    expect(invalidateMcpConfig).toHaveBeenCalledOnce();
  }, 15_000);

  it("failure case: crash stub → status stays 'down', error captured", async () => {
    seedRow({ id: "stub-crash", command: "node", args: [STUB_CRASH], serverStatus: "unknown" });

    const result = await retryMcpServer({ mcpId: "stub-crash" });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      mcpId: "stub-crash",
      status: "down",
      recoveredInThisSession: false,
    });
    expect(result.data!.error).toBeTruthy();

    const row = readRow("stub-crash");
    expect(row.serverStatus).toBe("down");
    expect(row.serverError).toBeTruthy();
    expect(row.serverLastChecked).toBeTruthy();

    // Cache must NOT be invalidated on failure
    expect(invalidateMcpConfig).not.toHaveBeenCalled();
  }, 15_000);

  it("guard: invalid mcpId → success: false with 'not found' message", async () => {
    const result = await retryMcpServer({ mcpId: "nonexistent-xyz" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(invalidateMcpConfig).not.toHaveBeenCalled();
  });

  it("guard: mcpId === 'libi' → success: false (cannot retry core)", async () => {
    seedRow({ id: "libi", command: "node", args: [STUB_OK], installStatus: "not_required", serverStatus: "unknown" });

    const result = await retryMcpServer({ mcpId: "libi" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/core/i);
    expect(invalidateMcpConfig).not.toHaveBeenCalled();

    // Row must be untouched
    const row = readRow("libi");
    expect(row.serverStatus).toBe("unknown");
  });

  it("guard: installStatus === 'failed' → success: false (deps not installed)", async () => {
    seedRow({
      id: "stub-deps-fail",
      command: "node",
      args: [STUB_OK],
      installStatus: "failed",
      serverStatus: "down",
    });

    const result = await retryMcpServer({ mcpId: "stub-deps-fail" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/dependencies not installed/i);
    expect(invalidateMcpConfig).not.toHaveBeenCalled();

    // serverStatus must be untouched (no probe was run)
    const row = readRow("stub-deps-fail");
    expect(row.serverStatus).toBe("down");
  });
});
