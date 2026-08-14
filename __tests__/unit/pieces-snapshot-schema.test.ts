import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";

describe("pieces snapshot/draft columns", () => {
  afterEach(() => resetTestDb());

  it("hasDraft defaults to false on insert", async () => {
    const db = createTestDb();
    const [row] = await db.insert(pieces).values({ name: "test" }).returning();
    expect(row.hasDraft).toBe(false);
  });

  it("snapshotSummary defaults to null", async () => {
    const db = createTestDb();
    const [row] = await db.insert(pieces).values({ name: "test" }).returning();
    expect(row.snapshotSummary).toBeNull();
  });

  it("both can be set explicitly", async () => {
    const db = createTestDb();
    const [row] = await db.insert(pieces).values({ name: "test", hasDraft: true, snapshotSummary: "v1 baseline" }).returning();
    expect(row.hasDraft).toBe(true);
    expect(row.snapshotSummary).toBe("v1 baseline");
  });
});
