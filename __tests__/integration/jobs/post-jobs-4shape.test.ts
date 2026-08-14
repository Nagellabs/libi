/**
 * Task 13 integration test: verify `JobManager.enqueue` returns one of four
 * discriminated shapes (`new`, `attached_running`, `matching_completed`,
 * `new` + `forced: true`) based on the (kind, paramsHash) state of the DB.
 *
 * The test exercises the real JobManager + real registry + real
 * canonical-hash, with an in-memory DB. Only `@/mcp/notify` is mocked so
 * progress events don't cross process boundaries.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({
  notify: { jobProgress: vi.fn() },
}));

import { getDb } from "@/lib/db/client";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";

describe("4-shape enqueue response", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
    registerRunner({
      kind: "k4",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ p: z.string() }),
      async run(ctx) {
        // Slow runner so the running test can observe in-flight state.
        await new Promise((r) => setTimeout(r, 200));
        ctx.reportProgress(1, 1, "x");
        return { ok: true };
      },
    });
  });

  it("returns status:new for first call (no match)", async () => {
    const mgr = new JobManager();
    const result = await mgr.enqueue("k4", { p: "1" });
    expect(result.status).toBe("new");
    if (result.status === "new") {
      expect(result.jobId).toMatch(/^job-/);
      expect(result.clientKey).toBeTruthy();
    }
  });

  it("returns status:attached_running when a running job with same hash exists", async () => {
    const mgr = new JobManager();
    const first = await mgr.enqueue("k4", { p: "running" });
    if (first.status !== "new") throw new Error("expected new");
    void mgr.runToCompletion(first.jobId);
    // Give it a moment to flip status to running.
    await new Promise((r) => setTimeout(r, 50));

    const second = await mgr.enqueue("k4", { p: "running" });
    expect(second.status).toBe("attached_running");
    if (second.status === "attached_running") {
      expect(second.jobId).toBe(first.jobId);
      expect(second.existingJob.jobId).toBe(first.jobId);
    }
  });

  it("returns status:matching_completed when a completed job with same hash exists", async () => {
    const mgr = new JobManager();
    const first = await mgr.enqueue("k4", { p: "done" });
    if (first.status !== "new") throw new Error("expected new");
    await mgr.runToCompletion(first.jobId);

    const second = await mgr.enqueue("k4", { p: "done" });
    expect(second.status).toBe("matching_completed");
    if (second.status === "matching_completed") {
      expect(second.existingJob.jobId).toBe(first.jobId);
      expect(second.existingJob.status).toBe("completed");
    }
  });

  it("returns status:new (forced:true) when forceNew:true", async () => {
    const mgr = new JobManager();
    const first = await mgr.enqueue("k4", { p: "force" });
    if (first.status !== "new") throw new Error("expected new");
    await mgr.runToCompletion(first.jobId);

    const second = await mgr.enqueue("k4", { p: "force" }, { forceNew: true });
    expect(second.status).toBe("new");
    if (second.status === "new" && "forced" in second) {
      expect(second.forced).toBe(true);
      expect(second.jobId).not.toBe(first.jobId);
    }
  });

  it("legacy resume:false is the deprecated alias for forceNew:true", async () => {
    const mgr = new JobManager();
    const first = await mgr.enqueue("k4", { p: "legacy" });
    if (first.status !== "new") throw new Error("expected new");
    await mgr.runToCompletion(first.jobId);

    const second = await mgr.enqueue("k4", { p: "legacy" }, { resume: false });
    expect(second.status).toBe("new");
    if (second.status === "new" && "forced" in second) {
      expect(second.forced).toBe(true);
      expect(second.jobId).not.toBe(first.jobId);
    }
  });

  it("clientKey is echoed when the caller supplies one; generated otherwise", async () => {
    const mgr = new JobManager();
    const supplied = await mgr.enqueue(
      "k4",
      { p: "ck1" },
      { clientKey: "my-key-abc" },
    );
    expect(supplied.status).toBe("new");
    if (supplied.status === "new") {
      expect(supplied.clientKey).toBe("my-key-abc");
    }

    const generated = await mgr.enqueue("k4", { p: "ck2" });
    expect(generated.status).toBe("new");
    if (generated.status === "new") {
      expect(generated.clientKey).toMatch(/^srv-/);
    }
  });
});
