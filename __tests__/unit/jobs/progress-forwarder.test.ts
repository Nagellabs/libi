import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { forwardJobProgressViaMcp } from "@/lib/jobs/progress-forwarder";
import { jobIdOf } from "../../helpers/enqueue";

describe("forwardJobProgressViaMcp", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("sends notifications/progress for each progress event when a progressToken is present", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        ctx.reportProgress(1, 10);
        await new Promise((r) => setTimeout(r, 1100));
        ctx.reportProgress(10, 10);
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const unsubscribe = forwardJobProgressViaMcp({
      mgr, jobId, progressToken: "tok-abc", sendNotification,
    });
    try {
      await mgr.runToCompletion(jobId);
    } finally {
      unsubscribe();
    }

    expect(sendNotification).toHaveBeenCalled();
    const calls = sendNotification.mock.calls.map(
      ([n]) =>
        n as { method: string; params: { progressToken: string; progress: number; total: number } },
    );
    for (const n of calls) {
      expect(n.method).toBe("notifications/progress");
      expect(n.params.progressToken).toBe("tok-abc");
      expect(typeof n.params.progress).toBe("number");
      expect(typeof n.params.total).toBe("number");
    }
  });

  it("no-ops when progressToken is undefined", async () => {
    const sendNotification = vi.fn();
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) { ctx.reportProgress(1, 1); return { ok: true }; },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const unsubscribe = forwardJobProgressViaMcp({
      mgr, jobId, progressToken: undefined, sendNotification,
    });
    try {
      await mgr.runToCompletion(jobId);
    } finally {
      unsubscribe();
    }

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    let resolveRunner: (() => void) | null = null;
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        ctx.reportProgress(1, 10);
        await new Promise<void>((r) => { resolveRunner = r; });
        ctx.reportProgress(10, 10);
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const unsubscribe = forwardJobProgressViaMcp({
      mgr, jobId, progressToken: "tok", sendNotification,
    });
    const runPromise = mgr.runToCompletion(jobId);
    await new Promise((r) => setTimeout(r, 100));
    const before = sendNotification.mock.calls.length;
    unsubscribe();
    resolveRunner!();
    await runPromise;
    expect(sendNotification.mock.calls.length).toBe(before);
  });
});
