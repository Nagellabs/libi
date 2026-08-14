import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
  getRunner,
} from "@/lib/jobs/runners/registry";
import { analysisDescribeFrameRunner } from "@/lib/jobs/runners/analysis-describe-frame";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";

describe("analysisDescribeFrameRunner", () => {
  let tmp: string;
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    registerRunner(analysisDescribeFrameRunner);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-analysis-describe-test-"));
    process.env.LIBI_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("registers with the expected kind, schema, and concurrency cap", () => {
    expect(analysisDescribeFrameRunner.kind).toBe("analysis_describe_frame");
    expect(analysisDescribeFrameRunner.maxConcurrent).toBe(4);
    expect(analysisDescribeFrameRunner.resumable).toBe(false);
    // Schema rejects malformed input.
    expect(() =>
      analysisDescribeFrameRunner.paramsSchema.parse({
        fileId: "",
        frameIndex: 0,
      }),
    ).toThrow();
    expect(() =>
      analysisDescribeFrameRunner.paramsSchema.parse({
        fileId: "f1",
        frameIndex: -1,
      }),
    ).toThrow();
    expect(() =>
      analysisDescribeFrameRunner.paramsSchema.parse({
        fileId: "f1",
        frameIndex: 1.5,
      }),
    ).toThrow();
    // Happy parse:
    const parsed = analysisDescribeFrameRunner.paramsSchema.parse({
      fileId: "f1",
      frameIndex: 5,
    });
    expect(parsed).toEqual({ fileId: "f1", frameIndex: 5 });
  });

  it("is discoverable through the runner registry", () => {
    expect(getRunner("analysis_describe_frame")).toBe(
      analysisDescribeFrameRunner,
    );
  });

  it("happy path: stub runner completes and returns { frameIndex, ok }", async () => {
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("analysis_describe_frame", {
      fileId: "f1",
      frameIndex: 7,
    }));
    const result = await mgr.runToCompletion<{
      frameIndex: number;
      ok: true;
    }>(jobId);
    expect(result).toEqual({ frameIndex: 7, ok: true });
  });

  it("rejects bad params at enqueue time", async () => {
    const mgr = new JobManager();
    await expect(
      mgr.enqueue("analysis_describe_frame", {
        fileId: "f1",
        frameIndex: -1,
      } as unknown as { fileId: string; frameIndex: number }),
    ).rejects.toThrow();
  });
});
