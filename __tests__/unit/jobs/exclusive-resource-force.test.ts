/**
 * A forced restart must not destroy a download that is already succeeding.
 *
 * Measured on the packaged app, 2026-08-02. A spurious SSE `terminated` (the
 * job-events stream had no keep-alive, fixed in f716498a) made the agent think
 * `music_download_model` had failed, so it retried with force. Two things then
 * went wrong, and together they cost ~5.3 GB of a download that was fine:
 *
 *   1. `force` lived in the runner's `paramsSchema`, so `{force:true}` hashed
 *      differently from `{}`. The retry did not attach to the running job — it
 *      created a SECOND job over the same output directory.
 *   2. `forceNew` deletes the matching row outright, even when that row is
 *      still running, and schedules a fresh run. Whichever run calls
 *      `clearModelDir()` first destroys the other's work.
 *
 * The abandoned first row was left reading `completed` with 124 K on disk, so
 * the job status was actively misleading afterwards.
 *
 * The fix is opt-in per runner (`exclusiveResource`) rather than a blanket
 * change to `forceNew`: three call sites — chromium-render, recompute-segment,
 * jobs/[id]/retry — rely on `forceNew` returning a `new` shape, and forcing
 * every concurrent export to attach instead would be a different regression.
 * So the last two tests here pin the UNCHANGED behaviour for ordinary runners.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

/** A runner that parks inside run() until released, so a second enqueue lands
 *  while the first is genuinely in flight — the exact window that was lost. */
function buildBlockingRunner(opts: {
  exclusiveResource?: boolean;
  onRun?: (ctx: JobContext<Record<string, never>>) => void;
}) {
  let release!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registerRunner({
      kind: "excl",
      maxConcurrent: 1,
      paramsSchema: z.object({}),
      resumable: false,
      ...(opts.exclusiveResource ? { exclusiveResource: true as const } : {}),
      async run(ctx: JobContext<Record<string, never>>) {
        opts.onRun?.(ctx);
        resolveStarted();
        await gate;
        return { ok: true };
      },
    });
  });
  return { started, release: () => release() };
}

describe("forceNew against an exclusiveResource runner", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("attaches to the in-flight run instead of deleting it", async () => {
    const { started, release } = buildBlockingRunner({
      exclusiveResource: true,
    });
    const mgr = new JobManager();

    const first = await mgr.enqueue("excl", {});
    const firstId = jobIdOf(first);
    const running = mgr.runToCompletion(firstId);
    await started;

    const second = await mgr.enqueue("excl", {}, { forceNew: true });

    expect(
      second.status,
      "a forced retry must not schedule a second run over the same output dir",
    ).toBe("attached_running");
    expect(jobIdOf(second)).toBe(firstId);

    // The original row is still there. Deleting it is what orphaned the first
    // job and left its status unreadable.
    const row = vi
      .mocked(getDb)()
      .select()
      .from(jobs)
      .where(eq(jobs.id, firstId))
      .all()[0];
    expect(row).toBeDefined();

    release();
    await running;
  });

  it("still honours forceNew once the previous run is terminal", async () => {
    // Attaching is only correct while work is IN FLIGHT. After it finishes,
    // force must genuinely start over — otherwise there is no recovery path
    // from a corrupt install.
    const { started, release } = buildBlockingRunner({
      exclusiveResource: true,
    });
    const mgr = new JobManager();
    const first = await mgr.enqueue("excl", {});
    const firstId = jobIdOf(first);
    const running = mgr.runToCompletion(firstId);
    await started;
    release();
    await running;

    const second = await mgr.enqueue("excl", {}, { forceNew: true });
    expect(second.status).toBe("new");
    expect(jobIdOf(second)).not.toBe(firstId);
  });

  it("passes ctx.forced to the runner so it can discard partial output", async () => {
    const seen: boolean[] = [];
    const { started, release } = buildBlockingRunner({
      exclusiveResource: true,
      onRun: (ctx) => seen.push(ctx.forced === true),
    });
    const mgr = new JobManager();

    const plain = await mgr.enqueue("excl", {});
    const plainRun = mgr.runToCompletion(jobIdOf(plain));
    await started;
    release();
    await plainRun;

    const forced = await mgr.enqueue("excl", {}, { forceNew: true });
    await mgr.runToCompletion(jobIdOf(forced));

    expect(
      seen,
      "force is a restart policy carried on the enqueue options; a params " +
        "field would fork the paramsHash and re-create the original bug",
    ).toEqual([false, true]);
  });
});

describe("ordinary runners keep the existing forceNew contract", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("forceNew on a RUNNING job still returns a fresh `new` row", async () => {
    // chromium-render / recompute-segment / jobs[id]/retry all throw on any
    // status other than `new`. The exclusiveResource opt-in exists precisely
    // so this stays true for them.
    const { started, release } = buildBlockingRunner({});
    const mgr = new JobManager();
    const first = await mgr.enqueue("excl", {});
    const firstId = jobIdOf(first);
    const running = mgr.runToCompletion(firstId).catch(() => {});
    await started;

    const second = await mgr.enqueue("excl", {}, { forceNew: true });
    expect(second.status).toBe("new");
    expect(jobIdOf(second)).not.toBe(firstId);

    release();
    await running;
  });
});
