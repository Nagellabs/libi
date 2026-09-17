/**
 * `JobManager.handleProgress`'s 1 s debounce.
 *
 * The condition was `now - last < PROGRESS_DEBOUNCE_MS && done < total`: the
 * second half is an escape hatch so the FINAL tick is never swallowed. With
 * `total: 0` — how every unknown-size job reports (a yt-dlp stream with no
 * Content-Length, JobManager's own 0/0 baseline) — `done < total` is false for
 * EVERY tick, so the debounce never applied and each of ~10 lines a second
 * wrote the DB and emitted for the whole download.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

/** Run a job whose runner fires `ticks` back-to-back, and count what escaped. */
async function emittedTicks(
  ticks: (ctx: JobContext<unknown>) => void,
): Promise<{ done: number; total: number }[]> {
  registerRunner({
    kind: "k",
    maxConcurrent: 1,
    resumable: false,
    paramsSchema: z.object({}),
    async run(ctx: JobContext<unknown>) {
      ticks(ctx);
      return { ok: true };
    },
  });
  const mgr = new JobManager();
  const jobId = jobIdOf(await mgr.enqueue("k", {}));
  const seen: { done: number; total: number }[] = [];
  mgr.on("progress", (ev: { jobId: string; done: number; total: number }) => {
    if (ev.jobId === jobId) seen.push({ done: ev.done, total: ev.total });
  });
  await mgr.runToCompletion(jobId);
  // The progress chain is async — let it drain before counting.
  await new Promise((r) => setTimeout(r, 100));
  return seen;
}

describe("JobManager progress debounce", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("debounces an INDETERMINATE job (total 0) instead of writing every tick", async () => {
    const seen = await emittedTicks((ctx) => {
      for (let i = 1; i <= 20; i++) ctx.reportProgress(i * 1_000, 0, "bytes");
    });
    // One tick inside the debounce window, not twenty.
    expect(seen).toEqual([{ done: 1_000, total: 0 }]);
  });

  it("still lets the FINAL tick of a sized job through undebounced", async () => {
    const seen = await emittedTicks((ctx) => {
      for (let i = 1; i <= 20; i++) ctx.reportProgress(i, 20, "frames");
    });
    // The first tick (nothing to debounce against) and the terminal 20/20 —
    // the escape hatch the debounce condition exists to preserve.
    expect(seen).toEqual([
      { done: 1, total: 20 },
      { done: 20, total: 20 },
    ]);
  });
});
