import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";

vi.mock("@/mcp/notify", () => ({
  notify: {
    refreshMcpConfig: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notify } from "@/mcp/notify";
import { updateMcpServer } from "@/mcp/tools/mcp-server-tools";

let db: ReturnType<typeof createTestDb>;

// The table holds only libi-owned rows now that libi bundles no third-party MCP: the core row plus
// extension rows. Seeded by id so the tool's `kind` lookup against
// BUNDLED_MCP_SERVERS resolves.
function seed(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    type: "stdio" as const,
    command: "node",
    args: null,
    requireApproval: false,
    bundled: true,
    installStatus: "installed",
    envVars: null,
  };
}

beforeEach(() => {
  db = createTestDb();
  db.insert(mcpServers)
    .values([seed("libi", "libi"), seed("libi-tracking", "Tracking"), seed("whisper", "Whisper")])
    .run();
  vi.mocked(notify.refreshMcpConfig).mockReset();
});

afterEach(() => {
  resetTestDb();
});

describe("MCP row edit tools after providers", () => {
  it("has no way to create or delete a row", async () => {
    const mod = await import("@/mcp/tools/mcp-server-tools");
    expect("registerMcpServer" in mod).toBe(false);
    expect("removeMcpServer" in mod).toBe(false);
  });

  it("accepts requireApproval on a libi-owned row", async () => {
    const res = await updateMcpServer({ id: "libi-tracking", requireApproval: true });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ id: "libi-tracking", requireApproval: true });
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi-tracking")).get();
    expect(row!.requireApproval).toBe(true);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects every other field", async () => {
    const res = await updateMcpServer({ id: "libi-tracking", command: "evil" } as never);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/read-only/i);
    expect(res.data).toMatchObject({ message: expect.stringContaining("command") });
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi-tracking")).get();
    expect(row!.command).toBe("node");
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });

  it("refuses to touch the core libi row", async () => {
    const res = await updateMcpServer({ id: "libi", requireApproval: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/read-only/i);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "libi")).get();
    expect(row!.requireApproval).toBe(false);
  });

  it("returns no_change when requireApproval is omitted", async () => {
    const res = await updateMcpServer({ id: "libi-tracking" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("no_change");
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });

  it("returns not_found for an unknown id", async () => {
    const res = await updateMcpServer({ id: "nope", requireApproval: true });
    expect(res.success).toBe(false);
    expect(res.error).toBe("not_found");
    expect(res.data).toEqual({ id: "nope" });
  });

  it("has no enabled toggle — the column is gone with migration 0051", async () => {
    const mod = await import("@/mcp/tools/mcp-server-tools");
    expect("setMcpServerEnabled" in mod).toBe(false);
    const schemas = await import("@/mcp/tools/schemas");
    expect("setMcpServerEnabledSchema" in schemas).toBe(false);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "whisper")).get();
    expect(row).not.toHaveProperty("enabled");
  });
});
