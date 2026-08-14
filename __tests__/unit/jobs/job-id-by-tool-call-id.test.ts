import { describe, it, expect, beforeEach } from "vitest";
import { JobManager } from "@/lib/jobs/manager";

describe("getJobIdForToolCallId reverse lookup", () => {
  let mgr: JobManager;

  beforeEach(() => {
    mgr = new JobManager();
  });

  it("returns null when no jobId is attached", () => {
    expect(mgr.getJobIdForToolCallId("unknown-tc")).toBeNull();
  });

  it("returns the jobId after attachToolCallId is called", () => {
    mgr.attachToolCallId("job-A", "tc-1");
    expect(mgr.getJobIdForToolCallId("tc-1")).toBe("job-A");
  });

  it("supports multiple toolCallIds for the same jobId", () => {
    mgr.attachToolCallId("job-A", "tc-1");
    mgr.attachToolCallId("job-A", "tc-2");
    expect(mgr.getJobIdForToolCallId("tc-1")).toBe("job-A");
    expect(mgr.getJobIdForToolCallId("tc-2")).toBe("job-A");
  });

  it("overwrites when the same toolCallId is attached to a different job", () => {
    // Realistic only as a pathological case but the contract is the latest wins.
    mgr.attachToolCallId("job-A", "tc-1");
    mgr.attachToolCallId("job-B", "tc-1");
    expect(mgr.getJobIdForToolCallId("tc-1")).toBe("job-B");
  });
});
