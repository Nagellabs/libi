import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";
import { jobs } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({ notify: { jobProgress: vi.fn() } }));

import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { jobIdOf } from "../../helpers/enqueue";

describe("enqueue handles malformed cached resultJson defensively", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
    registerRunner({
      kind: "k_malformed",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ p: z.string() }),
      async run() {
        return { ok: true };
      },
    });
  });

  it("returns status:matching_completed with result:undefined when cached JSON is bad", async () => {
    const mgr = new JobManager();

    // First create a real job via enqueue + run it to terminal so canonical paramsHash is correct.
    const first = await mgr.enqueue("k_malformed", { p: "bad-json-test" });
    expect(first.status).toBe("new");
    const firstId = jobIdOf(first);
    await mgr.runToCompletion(firstId);

    // Corrupt the cached result JSON in the DB.
    const db = getDb();
    db.update(jobs)
      .set({ resultJson: "{ not valid json" })
      .where(eq(jobs.id, firstId))
      .run();

    // Now re-enqueue with same params — should hit matching_completed branch
    // without throwing despite the malformed JSON.
    const second = await mgr.enqueue("k_malformed", { p: "bad-json-test" });
    expect(second.status).toBe("matching_completed");
    if (second.status === "matching_completed") {
      expect(second.existingJob.jobId).toBe(firstId);
      expect(second.existingJob.status).toBe("completed");
      expect(second.existingJob.result).toBeUndefined();
    }
  });
});
