import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

interface Params { value: number }
interface Result { doubled: number }

function buildRunner(opts: {
  run?: (ctx: JobContext<Params>) => Promise<Result>;
  maxConcurrent?: number;
  resumable?: boolean;
} = {}) {
  return {
    kind: "test",
    maxConcurrent: opts.maxConcurrent ?? 4,
    paramsSchema: z.object({ value: z.number() }),
    resumable: opts.resumable ?? true,
    async run(ctx: JobContext<Params>): Promise<Result> {
      if (opts.run) return opts.run(ctx);
      return { doubled: ctx.params.value * 2 };
    },
  };
}

describe("JobManager.enqueue", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
  });

  it("inserts a new job row when nothing matches", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const out = await mgr.enqueue("test", { value: 3 });
    expect(out.status).toBe("new");
    const jobId = jobIdOf(out);
    expect(jobId).toMatch(/^job-/);
    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("queued");
    expect(row.kind).toBe("test");
  });

  it("rejects unknown kinds", async () => {
    const mgr = new JobManager();
    await expect(mgr.enqueue("not-registered", {})).rejects.toThrow(/no runner/i);
  });

  it("rejects invalid params per the runner's zod schema", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    await expect(mgr.enqueue("test", { value: "nope" })).rejects.toThrow(/value/i);
  });

  it("dedupes identical params → returns existing jobId (matching_completed after run)", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const a = await mgr.enqueue("test", { value: 7 });
    const aId = jobIdOf(a);
    // The first call inserts queued. Re-enqueue while still queued/running
    // would yield `attached_running`. Here we run it to completion so the
    // dedupe path produces `matching_completed`.
    await mgr.runToCompletion(aId);
    const b = await mgr.enqueue("test", { value: 7 });
    expect(b.status).toBe("matching_completed");
    if (b.status === "matching_completed") {
      expect(b.existingJob.jobId).toBe(aId);
    }
  });

  it("forceNew: true deletes the old row + inserts a new one (legacy resume:false alias works)", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const a = await mgr.enqueue("test", { value: 7 });
    const b = await mgr.enqueue("test", { value: 7 }, { resume: false });
    expect(b.status).toBe("new");
    if (b.status === "new" && "forced" in b) {
      expect(b.forced).toBe(true);
    }
    expect(jobIdOf(b)).not.toBe(jobIdOf(a));
  });

  it("runToCompletion executes the runner and returns the result", async () => {
    registerRunner(buildRunner());
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("test", { value: 21 }));
    const result = await mgr.runToCompletion(jobId);
    expect(result).toEqual({ doubled: 42 });
    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("completed");
  });

  it("propagates runner errors as job-failed + rethrows", async () => {
    registerRunner(buildRunner({
      run: async () => { throw new Error("kaboom"); },
    }));
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("test", { value: 1 }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/kaboom/);
    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("failed");
    expect(row.error).toBe("kaboom");
  });

  it("trips the watchdog when no progress for noProgressTimeoutMs", async () => {
    registerRunner({
      kind: "slow",
      maxConcurrent: 1,
      resumable: false,
      noProgressTimeoutMs: 100,
      paramsSchema: z.object({}),
      async run(_ctx) {
        // Never reports progress; just sleeps.
        await new Promise((r) => setTimeout(r, 1000));
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("slow", {}));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow();
    const row = vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no progress/i);
  });
});
