import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { recoverOrphanedJobs } from "@/lib/jobs/scheduler";

describe("recoverOrphanedJobs", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("transitions orphaned running rows to failed", async () => {
    const db = vi.mocked(getDb)();
    db.insert(jobs).values({
      id: "j1", kind: "tracking", status: "running",
      paramsHash: "h", paramsJson: "{}",
    }).run();
    db.insert(jobs).values({
      id: "j2", kind: "tracking", status: "completed",
      paramsHash: "h2", paramsJson: "{}",
    }).run();

    await recoverOrphanedJobs();

    const rows = db.select().from(jobs).all();
    const j1 = rows.find((r) => r.id === "j1")!;
    const j2 = rows.find((r) => r.id === "j2")!;
    expect(j1.status).toBe("failed");
    expect(j1.error).toMatch(/restarted/i);
    expect(j2.status).toBe("completed"); // untouched
  });

  it("transitions orphaned cancel-requested rows to cancelled", async () => {
    const db = vi.mocked(getDb)();
    db.insert(jobs).values({
      id: "c1", kind: "tracking", status: "cancel-requested",
      paramsHash: "h", paramsJson: "{}",
    }).run();

    await recoverOrphanedJobs();

    const row = db.select().from(jobs).all().find((r) => r.id === "c1")!;
    expect(row.status).toBe("cancelled");
    expect(row.completedAt).toBeInstanceOf(Date);
  });
});
