import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "@/lib/db/client";

describe("MCP Servers DB operations", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
  });

  it("inserts a custom MCP server", () => {
    db.insert(mcpServers)
      .values({
        id: "custom-1",
        name: "My Custom MCP",
        type: "stdio",
        command: "npx",
        args: '["my-mcp"]',
        installStatus: "not_required",
      })
      .run();

    const rows = db.select().from(mcpServers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("My Custom MCP");
    expect(rows[0].bundled).toBe(false);
    expect(rows[0].installStatus).toBe("not_required");
  });

  it("updates MCP server fields", () => {
    db.insert(mcpServers)
      .values({ id: "test-1", name: "Test", type: "stdio", command: "test" })
      .run();

    db.update(mcpServers)
      .set({ enabled: false, requireApproval: false })
      .where(eq(mcpServers.id, "test-1"))
      .run();

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, "test-1")).all();
    expect(row.enabled).toBe(false);
    expect(row.requireApproval).toBe(false);
  });

  it("deletes a non-bundled MCP server", () => {
    db.insert(mcpServers)
      .values({ id: "custom-1", name: "Custom", type: "http", url: "http://localhost:9999", bundled: false })
      .run();

    db.delete(mcpServers).where(eq(mcpServers.id, "custom-1")).run();

    const rows = db.select().from(mcpServers).all();
    expect(rows).toHaveLength(0);
  });

  it("lists all MCP servers", () => {
    db.insert(mcpServers)
      .values([
        { id: "custom-1", name: "Custom", type: "http", url: "http://localhost", bundled: false, installStatus: "not_required" },
        { id: "bundled-1", name: "Bundled", type: "stdio", command: "test", bundled: true, installStatus: "installed" },
      ])
      .run();

    const rows = db.select().from(mcpServers).all();
    expect(rows).toHaveLength(2);
  });
});
