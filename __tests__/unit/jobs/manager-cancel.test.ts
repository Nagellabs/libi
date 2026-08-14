import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { CancelledError } from "@/lib/jobs/types";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

interface P { ticks: number }

describe("JobManager cancellation", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  function buildRunner() {
    return {
      kind: "cancellable",
      maxConcurrent: 1,
      paramsSchema: z.object({ ticks: z.number() }),
      resumable: true,
      async run(ctx: JobContext<P>) {
        for (let i = 0; i < ctx.params.ticks; i++) {
          if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
          await new Promise((r) => setTimeout(r, 5));
          ctx.reportProgress(i + 1, ctx.params.ticks);
        }
        return { ticks: ctx.params.ticks };
      },
    };
  }

  it("cancel() during run flips status to cancelled", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("cancellable", { ticks: 100 }));
    const promise = mgr.runToCompletion(jobId).catch((e) => e);
    // Cancel after a small delay so the runner has started.
    setTimeout(() => { mgr.cancel(jobId).catch(() => {}); }, 30);
    const result = await promise;
    expect(result).toBeInstanceOf(CancelledError);

    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("cancelled");
  });

  it("cancel on already-completed is a no-op", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("cancellable", { ticks: 2 }));
    await mgr.runToCompletion(jobId);
    await mgr.cancel(jobId); // should not throw
    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("completed");
  });

  it("cancel() on unknown jobId throws JobNotFoundError", async () => {
    const mgr = new JobManager();
    const { JobNotFoundError } = await import("@/lib/jobs/types");
    await expect(mgr.cancel("nope")).rejects.toThrow(JobNotFoundError);
  });
});
