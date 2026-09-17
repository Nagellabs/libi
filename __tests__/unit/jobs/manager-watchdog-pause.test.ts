/**
 * `JobContext.pauseWatchdog()`.
 *
 * A runner's no-progress timeout is tuned to its OWN work. The tracking
 * runner's 60 s fits per-frame ticks; it does not fit the first-use dependency
 * install that can run in front of them — a 33 MB model fetch that reports
 * nothing, then a 173 MB Chromium download whose installer emits one line per
 * 10 %, minutes apart on a slow link. The watchdog killed the job and reported
 * it as a tracking failure.
 *
 * The pause is scoped to that phase and refcounted, and releasing it re-stamps
 * `lastProgressAt` so the excused time is never charged to the job.
 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowOf(jobId: string) {
  return vi.mocked(getDb)().select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
}

describe("JobManager watchdog pause", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("does not trip while a runner holds the pause, however long the phase runs", async () => {
    registerRunner({
      kind: "dep-install",
      maxConcurrent: 1,
      resumable: false,
      noProgressTimeoutMs: 100,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        const release = ctx.pauseWatchdog!();
        // 5x the timeout, silent throughout — the shape of the Chromium
        // download this exists for.
        await sleep(500);
        release();
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("dep-install", {}));
    await expect(mgr.runToCompletion(jobId)).resolves.toEqual({ ok: true });
    expect(rowOf(jobId).status).toBe("completed");
  });

  it("re-arms after the release, with a FRESH baseline", async () => {
    registerRunner({
      kind: "dep-then-silence",
      maxConcurrent: 1,
      resumable: false,
      noProgressTimeoutMs: 150,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        const release = ctx.pauseWatchdog!();
        await sleep(400);
        release();
        // The paused 400 ms must NOT count: the watchdog gets a full 150 ms
        // from here. A baseline that was never re-stamped would abort on the
        // very next poll, and this job would die before its own silence
        // reached the timeout.
        await sleep(60);
        // Still alive — now go silent past the timeout on purpose.
        await sleep(600);
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("dep-then-silence", {}));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/no progress/i);
    const row = rowOf(jobId);
    expect(row.status).toBe("failed");
    // The counters are untouched by the re-arm — only `lastProgressAt` moved.
    expect(row.progressDone).toBe(0);
    expect(row.progressTotal).toBe(0);
  });

  it("is refcounted: an inner release does not re-arm the outer pause", async () => {
    registerRunner({
      kind: "nested",
      maxConcurrent: 1,
      resumable: false,
      noProgressTimeoutMs: 100,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        const outer = ctx.pauseWatchdog!();
        const inner = ctx.pauseWatchdog!();
        inner();
        // Double release of the same handle must not decrement twice.
        inner();
        await sleep(400);
        outer();
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("nested", {}));
    await expect(mgr.runToCompletion(jobId)).resolves.toEqual({ ok: true });
  });

  it("leaves an unpaused job's watchdog exactly as it was", async () => {
    registerRunner({
      kind: "plain",
      maxConcurrent: 1,
      resumable: false,
      noProgressTimeoutMs: 100,
      paramsSchema: z.object({}),
      async run() {
        await sleep(600);
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("plain", {}));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/no progress/i);
  });
});
