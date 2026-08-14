import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
// Mock the notify module so we can observe calls.
vi.mock("@/mcp/notify", () => ({
  notify: {
    jobProgress: vi.fn(),
  },
}));

import { getDb } from "@/lib/db/client";
import { notify } from "@/mcp/notify";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

describe("JobManager progress notify bridge", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
  });

  it("emits notify.jobProgress when a runner reports progress", async () => {
    registerRunner({
      kind: "k",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        // Report progress + wait so the throttle allows the second emit.
        ctx.reportProgress(5, 10, "frames");
        await new Promise((r) => setTimeout(r, 1100));
        ctx.reportProgress(10, 10, "frames");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));
    await mgr.runToCompletion(jobId);

    // The chain is async — give it a moment to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(notify.jobProgress).toHaveBeenCalled();
    const calls = vi.mocked(notify.jobProgress).mock.calls;
    const ourCalls = calls.filter(([arg]) => arg.jobId === jobId);
    expect(ourCalls.length).toBeGreaterThan(0);
    const lastCall = ourCalls[ourCalls.length - 1][0];
    expect(lastCall.kind).toBe("k");
    expect(lastCall.done).toBeGreaterThan(0);
    expect(lastCall.unit).toBe("frames");
  });

  it("attachToolCallId threads the toolCallId into notify calls", async () => {
    registerRunner({
      kind: "k",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        ctx.reportProgress(1, 1, "items");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k", {}));
    mgr.attachToolCallId(jobId, "tool-call-abc");
    await mgr.runToCompletion(jobId);

    await new Promise((r) => setTimeout(r, 50));

    const calls = vi
      .mocked(notify.jobProgress)
      .mock.calls.filter(([arg]) => arg.jobId === jobId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0].toolCallId).toBe("tool-call-abc");
  });

  it("attachToolCallId stores multiple toolCallIds and fans out emits", async () => {
    registerRunner({
      kind: "k_multi",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        ctx.reportProgress(1, 1, "items");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("k_multi", {}));
    mgr.attachToolCallId(jobId, "tool-call-1");
    mgr.attachToolCallId(jobId, "tool-call-2");
    await mgr.runToCompletion(jobId);

    await new Promise((r) => setTimeout(r, 50));

    const calls = vi
      .mocked(notify.jobProgress)
      .mock.calls.filter(([arg]) => arg.jobId === jobId);
    expect(calls.length).toBeGreaterThan(0);
    // Should see emits for both toolCallIds.
    const toolCallIds = new Set(calls.map(([arg]) => arg.toolCallId));
    expect(toolCallIds).toContain("tool-call-1");
    expect(toolCallIds).toContain("tool-call-2");
  });
});
