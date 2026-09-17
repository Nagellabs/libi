import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { recoverOrphanedJobs } from "@/lib/jobs/scheduler";

describe("recoverOrphanedJobs — queued orphans", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("finalizes a queued row left by a previous process", async () => {
    const db = vi.mocked(getDb)();
    const before = Date.now() - 60_000;
    db.insert(jobs).values({
      id: "job-old", kind: "runtime_update", status: "queued",
      paramsHash: "h", paramsJson: "{}", createdAt: new Date(before),
    }).run();

    await recoverOrphanedJobs(Date.now() - 1_000);

    const row = db.select().from(jobs).all().find((r) => r.id === "job-old")!;
    expect(row.status).toBe("failed");
  });

  // Guards against the naive fix: sweeping every `queued` row regardless of
  // when it was created would also fail this row, which is a job THIS
  // process just enqueued and will pick up itself — the cutoff comparison
  // against `processStartedAt` is what a blanket "queued → failed" sweep
  // would get wrong and kill a live job in flight.
  it("leaves a queued row created by THIS process alone", async () => {
    const db = vi.mocked(getDb)();
    const start = Date.now() - 1_000;
    db.insert(jobs).values({
      id: "job-live", kind: "export", status: "queued",
      paramsHash: "h", paramsJson: "{}", createdAt: new Date(),
    }).run();

    await recoverOrphanedJobs(start);

    const row = db.select().from(jobs).all().find((r) => r.id === "job-live")!;
    expect(row.status).toBe("queued");
  });
});
