// __tests__/integration/agent-install-flow.test.ts
//
// End-to-end smoke for the tier-1/tier-2 install split. Verifies the
// wiring between the seeded DB, the agent-facing install tools, and the
// mcp-config invalidation hook — without booting a real libi server.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the db client and mcp-config BEFORE importing the SUT — matches
// the unit-test pattern at __tests__/unit/mcp/bundled-mcps/install-tools.test.ts.
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
const invalidateMock = vi.fn();
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: (...args: unknown[]) => invalidateMock(...args),
}));

// Probe and session-manager are not exercised here but the SUT imports
// them at module-load time, so we stub them to keep the import side-effect-free.
vi.mock("@/mcp/registry/server-prober", () => ({
  probeAndPersist: vi.fn(),
}));
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({ scheduleSessionReload: vi.fn() }),
}));

import { getInstallPlan, updateDepStatus } from "@/mcp/bundled-mcps/install-tools";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

describe("agent install flow — tier-1/tier-2 integration", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    invalidateMock.mockClear();
    seedDatabase(db as never);
  });

  afterEach(() => {
    resetTestDb();
  });

  it("seeded DB starts tier-2 MCPs as pending (npx will run them on first use)", () => {
    const yt = db.select().from(mcpServers).where(eq(mcpServers.id, "youtube-downloader")).all()[0];
    expect(yt.installStatus).toBe("pending");
    // ElevenLabs and fal-ai start at needs_config because they need API keys
    const eleven = db.select().from(mcpServers).where(eq(mcpServers.id, "elevenlabs")).all()[0];
    expect(eleven.installStatus).toBe("needs_config");
    const fal = db.select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).all()[0];
    expect(fal.installStatus).toBe("needs_config");
  });

  it("buildMcpServers includes youtube-downloader (pending) but excludes elevenlabs (needs_config)", async () => {
    const real = await vi.importActual<typeof import("@/lib/mcp-config")>("@/lib/mcp-config");
    real.invalidateMcpConfig();
    const servers = real.getMcpServersForSettings();
    expect(servers["YouTube Downloader"]).toBeDefined();
    expect(servers["ElevenLabs"]).toBeUndefined();
  });

  it("get_install_plan returns the yt-dlp plan content read from disk", async () => {
    const result = await getInstallPlan({ mcpId: "youtube-downloader" });
    if (!result.success) {
      throw new Error(`expected success, got: ${result.error}`);
    }
    expect(result.plan).toContain("YouTube Downloader");
    expect(result.plan).toContain("yt-dlp");
    expect(result.planPath).toBe("mcp/bundled-mcps/plans/yt-dlp.md");
  });

  it("update_dep_status records 'installed' and triggers MCP-config invalidation", async () => {
    const result = await updateDepStatus({
      mcpId: "youtube-downloader",
      status: "installed",
      version: "0.8.4",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.newStatus).toBe("installed");

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-downloader"))
      .all()[0];
    expect(row.installStatus).toBe("installed");
    expect(row.installError).toBeNull();

    expect(invalidateMock).toHaveBeenCalledWith({
      reason: "agent-update-dep-status",
    });
  });

  it("full flow: seeded → get plan → record installing → record installed", async () => {
    // 1. Initial state from seed.
    const initial = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-downloader"))
      .all()[0];
    expect(initial.installStatus).toBe("pending");

    // 2. Agent reads the install plan.
    const plan = await getInstallPlan({ mcpId: "youtube-downloader" });
    if (!plan.success) throw new Error(`plan failed: ${plan.error}`);
    expect(plan.plan.length).toBeGreaterThan(100);

    // 3. Agent records progress as it works through the plan.
    await updateDepStatus({ mcpId: "youtube-downloader", status: "installing" });
    expect(
      db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, "youtube-downloader"))
        .all()[0].installStatus,
    ).toBe("installing");

    // 4. Agent marks the MCP installed.
    await updateDepStatus({
      mcpId: "youtube-downloader",
      status: "installed",
      version: "0.8.4",
    });
    const final = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-downloader"))
      .all()[0];
    expect(final.installStatus).toBe("installed");

    // Cache invalidation should have fired for each status write.
    expect(invalidateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("update_dep_status rejects tier-1 MCPs (libi core is off-limits)", async () => {
    const result = await updateDepStatus({ mcpId: "libi", status: "installed" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/tier-1|core/i);

    // And the DB row was NOT mutated.
    const libi = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "libi"))
      .all()[0];
    expect(libi.installStatus).toBe("pending");
  });
});
