import { describe, it, expect, vi, beforeEach } from "vitest";

const { scheduleReloadMock, invalidateMock, dbGetMock } = vi.hoisted(() => ({
  scheduleReloadMock: vi.fn(),
  invalidateMock: vi.fn(),
  dbGetMock: vi.fn().mockReturnValue(undefined), // default: no row found
}));
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    scheduleSessionReload: scheduleReloadMock,
  }),
}));
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: invalidateMock,
}));
// Mock the DB used by the fallback lookup in restart-mcp.ts
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: dbGetMock,
        }),
      }),
    }),
  }),
}));

import { restartMcpServer } from "@/mcp/bundled-mcps/restart-mcp";

describe("restartMcpServer", () => {
  beforeEach(() => {
    scheduleReloadMock.mockClear();
    invalidateMock.mockClear();
    dbGetMock.mockClear();
    dbGetMock.mockReturnValue(undefined); // default: no row found in DB fallback
  });

  it("returns success=true for a known MCP id", async () => {
    const result = await restartMcpServer(
      { mcpId: "youtube-downloader" },
      { sessionId: "abc123" },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("invalidates the mcp-config cache so the reload picks up fresh state", async () => {
    await restartMcpServer({ mcpId: "youtube-downloader" }, { sessionId: "abc123" });
    expect(invalidateMock).toHaveBeenCalled();
  });

  it("schedules a session reload for the current session", async () => {
    await restartMcpServer({ mcpId: "youtube-downloader" }, { sessionId: "abc123" });
    expect(scheduleReloadMock).toHaveBeenCalledWith("abc123");
  });

  it("returns success=false for unknown mcpId", async () => {
    const result = await restartMcpServer(
      { mcpId: "nope" },
      { sessionId: "abc123" },
    );
    expect(result.success).toBe(false);
  });

  it("gracefully degrades (success=true, refresh config + standby) when sessionId is empty", async () => {
    // No sessionId threaded (a known claude-agent-acp gap). The tool can't reload
    // THIS session, but still invalidates config + rebuilds standby and returns
    // success with new-chat guidance — it does NOT hard-fail.
    const result = await restartMcpServer(
      { mcpId: "youtube-downloader" },
      { sessionId: "" },
    );
    expect(result.success).toBe(true);
    expect(invalidateMock).toHaveBeenCalled();
    expect(scheduleReloadMock).not.toHaveBeenCalled();
    if (result.success) expect(result.message).toMatch(/new chat/i);
  });
});
