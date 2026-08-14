import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { jobIdOf } from "../../helpers/enqueue";

describe("JobManager dedupe ignores terminal rows", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    registerRunner({
      kind: "k",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.number() }),
      async run() { return { ok: true }; },
    });
  });

  it("re-enqueueing after completion returns matching_completed (not a new row by default)", async () => {
    const mgr = new JobManager();
    const a = await mgr.enqueue("k", { v: 1 });
    const aId = jobIdOf(a);
    await mgr.runToCompletion(aId);

    const b = await mgr.enqueue("k", { v: 1 });
    expect(b.status).toBe("matching_completed");
    if (b.status === "matching_completed") {
      expect(b.existingJob.jobId).toBe(aId);
      expect(b.existingJob.status).toBe("completed");
    }

    const rows = vi.mocked(getDb)().select().from(jobs).all();
    // Only the one (completed) row exists — no new queued row was created.
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("completed");
  });

  it("re-enqueueing while still running attaches to the existing job", async () => {
    const release: Array<() => void> = [];
    __resetRunnerRegistryForTests();
    registerRunner({
      kind: "k",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.number() }),
      async run() {
        await new Promise<void>((r) => release.push(r));
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const a = await mgr.enqueue("k", { v: 2 });
    const aId = jobIdOf(a);
    const pa = mgr.runToCompletion(aId);
    await new Promise((r) => setTimeout(r, 20));

    const b = await mgr.enqueue("k", { v: 2 });
    expect(b.status).toBe("attached_running");
    if (b.status === "attached_running") {
      expect(b.jobId).toBe(aId);
      expect(b.existingJob.jobId).toBe(aId);
    }

    release[0]();
    await pa;
  });
});
