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
  it("returns the yt-dlp install plan when mcpId='youtube-downloader'", async () => {
    const result = await getInstallPlan({ mcpId: "youtube-downloader" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.plan).toContain("YouTube Downloader");
    expect(result.plan).toContain("yt-dlp");
  });

  it("returns the elevenlabs plan", async () => {
    const result = await getInstallPlan({ mcpId: "elevenlabs" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.plan).toContain("ElevenLabs");
  });

  it("returns the fal-ai plan", async () => {
    const result = await getInstallPlan({ mcpId: "fal-ai" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.plan).toContain("fal.ai");
  });

  it("returns success=false with a helpful error for an unknown mcpId", async () => {
    const result = await getInstallPlan({ mcpId: "nonexistent" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/unknown.*mcp/i);
    expect(result.knownIds).toContain("youtube-downloader");
  });

  it("returns success=false for a tier-1 mcpId (no install plan)", async () => {
    const result = await getInstallPlan({ mcpId: "libi" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toMatch(/tier-1|core/i);
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
      mcpId: "youtube-downloader",
      status: "installed",
      version: "0.8.4",
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-downloader"))
      .all()[0];
    expect(row.installStatus).toBe("installed");
    expect(invalidateMock).toHaveBeenCalledWith({ reason: "agent-update-dep-status" });
  });

  it("merges env into the row's envVars when provided", async () => {
    const result = await updateDepStatus({
      mcpId: "elevenlabs",
      status: "installing",
      env: { ELEVENLABS_API_KEY: "sk_test_123" },
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "elevenlabs"))
      .all()[0];
    const parsedEnv = JSON.parse(row.envVars ?? "{}");
    expect(parsedEnv.ELEVENLABS_API_KEY).toBe("sk_test_123");
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
      mcpId: "fal-ai",
      status: "failed",
      error: "User declined to provide an API key",
    });
    expect(result.success).toBe(true);

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "fal-ai"))
      .all()[0];
    expect(row.installStatus).toBe("failed");
    expect(row.installError).toBe("User declined to provide an API key");
  });
});

describe("recheckMcp", () => {
  beforeEach(() => {
    probeMock.mockClear();
  });

  it("calls probeAndPersist with the def and returns the result", async () => {
    probeMock.mockResolvedValue({ status: "up", error: null, durationMs: 350 });
    const result = await recheckMcp({ mcpId: "youtube-downloader" });
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
    const result = await recheckMcp({ mcpId: "youtube-downloader" });
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
