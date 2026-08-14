import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

interface P { fileId: string; total: number }
interface S { done: number; partial: string[] }

describe("JobManager resume", () => {
  let tmp: string;
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-jobs-resume-"));
    process.env.LIBI_HOME = tmp;
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function buildRunner(opts: { failAt?: number } = {}) {
    return {
      kind: "resumable-test",
      maxConcurrent: 1,
      paramsSchema: z.object({ fileId: z.string(), total: z.number() }),
      resumable: true,
      async run(ctx: JobContext<P>) {
        const prior = (ctx.resumeState as S | null) ?? { done: 0, partial: [] };
        const partial = [...prior.partial];
        for (let i = prior.done; i < ctx.params.total; i++) {
          if (opts.failAt != null && i === opts.failAt) {
            await ctx.checkpoint({ done: i, partial });
            throw new Error("simulated failure");
          }
          partial.push(`item-${i}`);
          ctx.reportProgress(i + 1, ctx.params.total);
        }
        return { items: partial };
      },
    };
  }

  it("checkpointed state is restored on the second runToCompletion", async () => {
    registerRunner(buildRunner({ failAt: 3 }));
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("resumable-test", { fileId: "f", total: 10 }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/simulated/);

    // Register a fresh non-failing runner and resume the same job.
    __resetRunnerRegistryForTests();
    registerRunner(buildRunner());
    // Manually flip the failed job back to queued so it can run again.
    // (Real callers re-enqueue with resume:true which finds the row; here we
    //  bypass that to test resumeState wiring directly.)
    const { jobs } = await import("@/lib/db/schema/sqlite");
    const { eq } = await import("drizzle-orm");
    vi.mocked(getDb)().update(jobs).set({ status: "queued", error: null }).where(eq(jobs.id, jobId)).run();

    const result = await mgr.runToCompletion(jobId);
    // The runner resumed from item-3 onward; total items 10.
    expect((result as { items: string[] }).items.length).toBe(10);
    expect((result as { items: string[] }).items[0]).toBe("item-0");
    expect((result as { items: string[] }).items[3]).toBe("item-3");
  });

  it("ctx.checkpoint writes to partialPath under ~/.libi/jobs/{id}/state.json", async () => {
    registerRunner(buildRunner({ failAt: 2 }));
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("resumable-test", { fileId: "f2", total: 5 }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow();
    const file = path.join(tmp, "jobs", jobId, "state.json");
    expect(fs.existsSync(file)).toBe(true);
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(state.done).toBe(2);
    expect(state.partial).toEqual(["item-0", "item-1"]);
  });

  it("partial state file is deleted on successful completion", async () => {
    registerRunner(buildRunner({ failAt: 1 }));
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("resumable-test", { fileId: "f3", total: 3 }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow();
    const file = path.join(tmp, "jobs", jobId, "state.json");
    expect(fs.existsSync(file)).toBe(true);

    // Re-register success path + flip to queued, then run again.
    __resetRunnerRegistryForTests();
    registerRunner(buildRunner());
    const { jobs } = await import("@/lib/db/schema/sqlite");
    const { eq } = await import("drizzle-orm");
    vi.mocked(getDb)().update(jobs).set({ status: "queued", error: null }).where(eq(jobs.id, jobId)).run();
    await mgr.runToCompletion(jobId);

    // After successful completion, the partial file should be deleted.
    expect(fs.existsSync(file)).toBe(false);
  });
});
