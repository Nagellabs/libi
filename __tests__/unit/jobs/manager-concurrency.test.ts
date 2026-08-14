import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

describe("JobManager concurrency", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("with maxConcurrent: 1, a second runToCompletion waits for the first to finish", async () => {
    let activeCount = 0;
    let maxObserved = 0;
    const release: Array<() => void> = [];

    registerRunner({
      kind: "k",
      maxConcurrent: 1,
      paramsSchema: z.object({ v: z.string() }),
      resumable: false,
      async run(ctx: JobContext<{ v: string }>) {
        activeCount++;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise<void>((r) => release.push(r));
        activeCount--;
        return { id: ctx.params.v };
      },
    });

    const mgr = new JobManager();
    const aId = jobIdOf(await mgr.enqueue("k", { v: "a" }));
    const bId = jobIdOf(await mgr.enqueue("k", { v: "b" }));

    const pa = mgr.runToCompletion(aId);
    const pb = mgr.runToCompletion(bId);

    // Let the first runner start, then release it.
    await new Promise((r) => setTimeout(r, 20));
    expect(activeCount).toBe(1);
    release[0]();
    await pa;
    // Now the second runner has a slot.
    await new Promise((r) => setTimeout(r, 20));
    expect(activeCount).toBe(1);
    release[1]();
    await pb;
    expect(maxObserved).toBe(1);
  });

  it("cancelling a queued job releases the waiter without running the runner", async () => {
    let runCount = 0;
    const release: Array<() => void> = [];

    registerRunner({
      kind: "k3",
      maxConcurrent: 1,
      paramsSchema: z.object({ v: z.string() }),
      resumable: false,
      async run() {
        runCount++;
        await new Promise<void>((r) => release.push(r));
        return { ok: true };
      },
    });

    const mgr = new JobManager();
    const aId = jobIdOf(await mgr.enqueue("k3", { v: "a" }));
    const bId = jobIdOf(await mgr.enqueue("k3", { v: "b" }));

    // Start both. `b` will queue waiting for `a` to finish.
    const pa = mgr.runToCompletion(aId);
    const pb = mgr.runToCompletion(bId).catch((e) => e);

    // Wait for runner `a` to be active.
    await new Promise((r) => setTimeout(r, 20));
    expect(runCount).toBe(1);

    // Cancel the queued one.
    await mgr.cancel(bId);

    // Let `a` finish.
    release[0]();
    await pa;

    // `b` should resolve to CancelledError without ever running.
    const { CancelledError } = await import("@/lib/jobs/types");
    const result = await pb;
    expect(result).toBeInstanceOf(CancelledError);
    expect(runCount).toBe(1); // runner never ran for b
  });

  it("with maxConcurrent: 2, two runs proceed in parallel", async () => {
    let activeCount = 0;
    let maxObserved = 0;
    const release: Array<() => void> = [];

    registerRunner({
      kind: "k2",
      maxConcurrent: 2,
      paramsSchema: z.object({ v: z.string() }),
      resumable: false,
      async run(ctx: JobContext<{ v: string }>) {
        activeCount++;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise<void>((r) => release.push(r));
        activeCount--;
        return { id: ctx.params.v };
      },
    });

    const mgr = new JobManager();
    const aId = jobIdOf(await mgr.enqueue("k2", { v: "a" }));
    const bId = jobIdOf(await mgr.enqueue("k2", { v: "b" }));
    const cId = jobIdOf(await mgr.enqueue("k2", { v: "c" }));

    const pa = mgr.runToCompletion(aId);
    const pb = mgr.runToCompletion(bId);
    const pc = mgr.runToCompletion(cId);

    await new Promise((r) => setTimeout(r, 20));
    expect(activeCount).toBe(2); // a + b
    release[0](); release[1]();
    await pa; await pb;
    await new Promise((r) => setTimeout(r, 20));
    expect(activeCount).toBe(1); // c
    release[2]();
    await pc;
    expect(maxObserved).toBe(2);
  });
});
