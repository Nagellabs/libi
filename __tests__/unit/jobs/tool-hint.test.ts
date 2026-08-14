import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({ notify: { jobProgress: vi.fn() } }));

import { getDb } from "@/lib/db/client";
import { notify } from "@/mcp/notify";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import type { JobContext } from "@/lib/jobs/types";
import { jobIdOf } from "../../helpers/enqueue";

describe("JobManager tool hints", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
  });

  it("stamps toolName/toolArgs/progressLabel on progress notifies", async () => {
    registerRunner({
      kind: "hinted",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx: JobContext<unknown>) {
        ctx.reportProgress(1, 10, "ticks");
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("hinted", {}));
    mgr.attachToolHint(jobId, {
      toolName: "libi.dev_slow_job",
      toolArgs: { seconds: 10 },
      progressLabel: "segment 2/7",
    });
    expect(mgr.getToolHint(jobId)).toMatchObject({ toolName: "libi.dev_slow_job" });
    await mgr.runToCompletion(jobId);
    await new Promise((r) => setTimeout(r, 50));

    const calls = vi.mocked(notify.jobProgress).mock.calls.map(([a]) => a);
    const ours = calls.filter((c) => c.jobId === jobId);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0]).toMatchObject({
      toolName: "libi.dev_slow_job",
      toolArgs: { seconds: 10 },
      progressLabel: "segment 2/7",
    });
  });

  it("getToolHint returns null after the job finishes (map cleared)", async () => {
    registerRunner({
      kind: "hinted2",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("hinted2", {}));
    mgr.attachToolHint(jobId, { toolName: "libi.x", toolArgs: {} });
    await mgr.runToCompletion(jobId);
    expect(mgr.getToolHint(jobId)).toBeNull();
  });
});
