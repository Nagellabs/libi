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

  /**
   * `total: 0` is how a job says "size unknown". Clamping it to
   * `Math.max(total, 1)` told the agent `progress: 43, total: 1` and climbing
   * — so the model's own rendering read "43/1 bytes". The MCP progress
   * notification represents indeterminate by OMITTING `total`.
   */
  it("omits total (and drops it from the message) for an indeterminate job", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        ctx.reportProgress(43, 0, "bytes");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const unsubscribe = forwardJobProgressViaMcp({
      mgr, jobId, progressToken: "tok", sendNotification,
    });
    try {
      await mgr.runToCompletion(jobId);
    } finally {
      unsubscribe();
    }

    const params = sendNotification.mock.calls.map(
      ([n]) => (n as { params: { progress: number; total?: number; message?: string } }).params,
    );
    expect(params).toHaveLength(1);
    expect(params[0].progress).toBe(43);
    expect("total" in params[0]).toBe(false);
    expect(params[0].message).toBe("43 bytes");
  });

  it("keeps total when the job knows its size", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        ctx.reportProgress(3, 10, "frames");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const unsubscribe = forwardJobProgressViaMcp({
      mgr, jobId, progressToken: "tok", sendNotification,
    });
    try {
      await mgr.runToCompletion(jobId);
    } finally {
      unsubscribe();
    }

    const params = sendNotification.mock.calls.map(
      ([n]) => (n as { params: { progress: number; total?: number; message?: string } }).params,
    );
    expect(params).toEqual([
      expect.objectContaining({ progress: 3, total: 10, message: "3/10 frames" }),
    ]);
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
