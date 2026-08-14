import { describe, it, expect } from "vitest";
import { snapshotFromRow } from "@/lib/jobs/types";
import type { JobRecord } from "@/lib/db/schema/types";

function baseRow(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    kind: "extra_analysis_model",
    clientKey: "",
    pieceId: "piece-1",
    fileId: "file-1",
    status: "running",
    paramsHash: "hash",
    paramsJson: "{}",
    progressDone: 0,
    progressTotal: 0,
    progressUnit: "items",
    msPerUnit: null,
    partialPath: null,
    resultJson: null,
    error: null,
    createdAt: new Date(0),
    startedAt: null,
    completedAt: null,
    lastProgressAt: null,
    ...overrides,
  };
}

describe("snapshotFromRow", () => {
  it("exposes fileId from the row", () => {
    const snap = snapshotFromRow(baseRow({ fileId: "file-abc" }));
    expect(snap.fileId).toBe("file-abc");
  });

  it("passes null fileId through unchanged", () => {
    const snap = snapshotFromRow(baseRow({ fileId: null }));
    expect(snap.fileId).toBeNull();
  });

  // Terminal ETA rules — the fix for the QA-observed "completed job with
  // stale etaMs: 427" and "745/751 done on a completed job" anomalies.
  it("completed job reports etaMs 0 and done coerced to total", () => {
    const snap = snapshotFromRow(
      baseRow({
        status: "completed",
        progressDone: 745,
        progressTotal: 751,
        msPerUnit: 71.2,
      }),
    );
    expect(snap.etaMs).toBe(0);
    expect(snap.progressDone).toBe(751);
  });

  it("failed job reports etaMs null", () => {
    const snap = snapshotFromRow(
      baseRow({ status: "failed", progressDone: 10, progressTotal: 100, msPerUnit: 50 }),
    );
    expect(snap.etaMs).toBeNull();
  });

  it("cancelled job reports etaMs null", () => {
    const snap = snapshotFromRow(
      baseRow({ status: "cancelled", progressDone: 265, progressTotal: 750, msPerUnit: 80 }),
    );
    expect(snap.etaMs).toBeNull();
  });

  it("running job keeps the window-derived remaining estimate", () => {
    const snap = snapshotFromRow(
      baseRow({ status: "running", progressDone: 50, progressTotal: 100, msPerUnit: 100 }),
    );
    expect(snap.etaMs).toBe(5000);
    expect(snap.progressDone).toBe(50);
  });
});
