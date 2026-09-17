import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the db client and mcp-config BEFORE importing the SUT.
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
const invalidateMock = vi.fn();
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: (...args: unknown[]) => invalidateMock(...args),
}));

const probeMock = vi.fn();
vi.mock("@/mcp/registry/server-prober", () => ({
  probeAndPersist: (...args: unknown[]) => probeMock(...args),
}));

const scheduleReloadMock = vi.fn();
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    scheduleSessionReload: (sessionId: string) => scheduleReloadMock(sessionId),
  }),
}));

import {
  getInstallPlan,
  updateDepStatus,
  recheckMcp,
  restartAcpSession,
} from "@/mcp/bundled-mcps/install-tools";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { seedDatabase } from "@/lib/db/init";

describe("getInstallPlan", () => {
  it("returns the tracking install plan when mcpId='libi-tracking'", async () => {
    const result = await getInstallPlan({ mcpId: "libi-tracking" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.plan).toContain("libi-tracking");
  });

  it("carries the extension's dependency readout (names + on-disk state, never a value)", async () => {
    const result = await getInstallPlan({ mcpId: "whisper" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    const uv = result.dependencies.find((d) => d.binary === "uv");
    expect(uv).toBeDefined();
    expect(typeof uv!.installed).toBe("boolean");
    // The readout is the plan's "confirm uv is present" step — an agent reads
    // it here instead of a settings card it cannot see.
    expect(result.plan).toContain('libi.get_install_plan({ mcpId: "whisper" })');
    expect(JSON.stringify(result)).not.toMatch(/Authorization|api[_-]?key=/i);
  });

  it("returns success=false for an extension libi installs itself (youtube-download has no plan)", async () => {
    const result = await getInstallPlan({ mcpId: "youtube-download" });
    expect(result.success).toBe(false);
  });

  it("returns success=false with a helpful error for an unknown mcpId", async () => {
    const result = await getInstallPlan({ mcpId: "nonexistent" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/unknown.*mcp/i);
    expect(result.knownIds).toContain("youtube-download");
  });

  it("returns success=false for a tier-1 mcpId (no install plan)", async () => {
    const result = await getInstallPlan({ mcpId: "libi" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/tier-1|core/i);
  });

  it("tells the agent libi installs libi-export itself, rather than calling the missing plan a bug", async () => {
    // Chromium downloads inside the first canvas export; an agent that asks
    // for its plan should be pointed at the export or its card on Agents →
    // libi MCP, not told to file a bug.
    const result = await getInstallPlan({ mcpId: "libi-export" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/libi installs this itself/);
    expect(result.error).toMatch(/run an export/);
    expect(result.error).toMatch(/Agents → Libi MCP → Canvas export \(Chromium\)/);
    expect(result.error).not.toMatch(/Settings/);
    expect(result.error).not.toMatch(/libi bug/);
  });
});

describe("updateDepStatus", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    invalidateMock.mockClear();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
  });

  afterEach(() => {
    resetTestDb();
    vi.restoreAllMocks();
  });

  it("writes status='installed' to the mcp_servers row and invalidates config", async () => {
    const result = await updateDepStatus({
      mcpId: "youtube-download",
      status: "installed",
      version: "2026.07.04",
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-download"))
      .all()[0];
    expect(row.installStatus).toBe("installed");
    expect(invalidateMock).toHaveBeenCalledWith({ reason: "agent-update-dep-status" });
  });

  it("merges env into the row's envVars when provided", async () => {
    const result = await updateDepStatus({
      mcpId: "local-music",
      status: "installing",
      env: { ACE_STEP_THREADS: "4" },
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "local-music"))
      .all()[0];
    const parsedEnv = JSON.parse(row.envVars ?? "{}");
    expect(parsedEnv.ACE_STEP_THREADS).toBe("4");
  });

  it("rejects updates for tier-1 (core) MCPs", async () => {
    const result = await updateDepStatus({
      mcpId: "libi",
      status: "installed",
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/tier-1|core/i);
  });

  it("records error message when status='failed'", async () => {
    const result = await updateDepStatus({
      mcpId: "local-music",
      status: "failed",
      error: "uv sync failed: no wheel for this platform",
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "local-music"))
      .all()[0];
    expect(row.installStatus).toBe("failed");
    expect(row.installError).toBe("uv sync failed: no wheel for this platform");
  });
});

describe("recheckMcp", () => {
  beforeEach(() => {
    probeMock.mockClear();
  });

  it("calls probeAndPersist with the def and returns the result", async () => {
    probeMock.mockResolvedValue({ status: "up", error: null, durationMs: 350 });
    const result = await recheckMcp({ mcpId: "libi-tracking" });
    expect(probeMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.status).toBe("up");
  });

  it("returns success=false for unknown mcpId", async () => {
    const result = await recheckMcp({ mcpId: "nope" });
    expect(result.success).toBe(false);
  });

  it("returns success=true with status='down' when probe says down", async () => {
    probeMock.mockResolvedValue({
      status: "down",
      error: "spawn ENOENT",
      durationMs: 120,
    });
    const result = await recheckMcp({ mcpId: "libi-tracking" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.status).toBe("down");
    expect(result.error).toContain("ENOENT");
  });
});

describe("restartAcpSession", () => {
  beforeEach(() => {
    scheduleReloadMock.mockClear();
  });

  it("schedules a reload for the current session and returns success", async () => {
    const result = await restartAcpSession({}, { sessionId: "abc123" });
    expect(scheduleReloadMock).toHaveBeenCalledWith("abc123");
    expect(result.success).toBe(true);
    // Tool message tells the agent to wrap up and tell the user to open a
    // new chat (claude-agent-acp can't swap mcpServers mid-session).
    expect(result.message.toLowerCase()).toMatch(/re-send|new chat|installed/);
  });
});

/**
 * The docs said `get_install_plan` "accepts both `mcpId` and
 * `extensionId`". Half true, and the wrong half: `{ mcpId, extensionId }`
 * parsed because zod strips the extra key, but `{ extensionId }` ALONE failed
 * with the SDK's bare `Required` — no hint about which spelling to use — while
 * every def in the registry is `kind: "extension"` and the manual calls the
 * argument "a libi **extension** id". So the guess an agent is most likely to
 * make was the one that could not work.
 *
 * `mcpId` stays canonical (six sibling tools, four install plans and the manual
 * spell it that way); `extensionId` is an accepted alias.
 */
describe("getInstallPlan accepts either spelling of the extension id", () => {
  it("resolves extensionId on its own", async () => {
    const result = await getInstallPlan({ extensionId: "whisper" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.mcpId).toBe("whisper");
  });

  it("prefers extensionId when both are given, and echoes one id back", async () => {
    const result = await getInstallPlan({ mcpId: "whisper", extensionId: "local-music" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.mcpId).toBe("local-music");
    expect(result.planPath).toContain("local-music");
  });

  it("names both keys when neither is supplied, instead of a bare 'Required'", async () => {
    const result = await getInstallPlan({});
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toContain("mcpId");
    expect(result.error).toContain("extensionId");
    expect(result.knownIds).toContain("local-music");
  });

  it("advertises both keys in tools/list rather than losing the schema", async () => {
    // The obvious implementation — z.preprocess around the object to normalise
    // the alias — is the trap: the MCP SDK's normalizeObjectSchema returns
    // undefined for a ZodEffects, so tools/list would fall back to
    // EMPTY_OBJECT_JSON_SCHEMA and this tool would advertise NO parameters.
    // Asserting the schema is a plain ZodObject with both fields is what keeps
    // a future "tidy-up" from reintroducing that.
    const { getInstallPlanSchema } = await import("@/mcp/tools/schemas");
    expect(Object.keys(getInstallPlanSchema.shape).sort()).toEqual(["extensionId", "mcpId"]);
    expect(getInstallPlanSchema.parse({ extensionId: "whisper" })).toEqual({
      extensionId: "whisper",
    });
  });
});
