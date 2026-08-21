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

  // This read path is what `libi.get_job_status` hands the agent, so a frozen
  // number here becomes a confident wrong answer in chat.
  it("ages a running job's ETA by the time since its last tick", () => {
    const now = 1_000_000;
    const snap = snapshotFromRow(
      baseRow({
        status: "running",
        progressDone: 50,
        progressTotal: 100,
        msPerUnit: 100, // naive estimate: 5s
        lastProgressAt: new Date(now - 2000),
      }),
      { now },
    );
    expect(snap.etaMs).toBe(3000);
    expect(snap.msSinceProgress).toBe(2000);
  });

  it("withdraws a running job's ETA once the wait outlives it", () => {
    const now = 1_000_000;
    const snap = snapshotFromRow(
      baseRow({
        status: "running",
        progressDone: 11,
        progressTotal: 12,
        msPerUnit: 65_000, // predicted ~1m 5s
        lastProgressAt: new Date(now - 15 * 60_000), // quiet for 15 minutes
      }),
      { now },
    );
    expect(snap.etaMs).toBeNull();
    expect(snap.msSinceProgress).toBe(15 * 60_000);
  });

  it("reports no msSinceProgress for a finished job", () => {
    const now = 1_000_000;
    const snap = snapshotFromRow(
      baseRow({
        status: "completed",
        progressDone: 12,
        progressTotal: 12,
        msPerUnit: 65_000,
        lastProgressAt: new Date(now - 60_000),
      }),
      { now },
    );
    // Would otherwise read as "quiet for 1m" on a job that simply ended.
    expect(snap.msSinceProgress).toBeNull();
    expect(snap.etaMs).toBe(0);
  });

  // Regression: the clock used to be a positional `now: number`, so the natural
  // `rows.map(snapshotFromRow)` in GET /api/jobs passed the ELEMENT INDEX as the
  // clock — `now = 0` for row 0. Every job then reported msSinceProgress 0 and an
  // undecayed ETA, silently defeating the staleness rule on the very endpoint
  // `libi.list_jobs` reads. Caught by watching a live job, not by a test.
  //
  // The options-object signature now makes that call a COMPILE error, which is
  // the real fix — hence the cast below, which is the only way to still express
  // the mistake. This asserts the runtime is also tolerant, so the same shape
  // reached from untyped JS degrades to the default clock instead of to zero.
  it("survives being used point-free in .map()", () => {
    const realNow = Date.now();
    const rows = [
      baseRow({
        id: "row-0",
        status: "running",
        progressDone: 11,
        progressTotal: 12,
        msPerUnit: 65_000,
        lastProgressAt: new Date(realNow - 15 * 60_000),
      }),
      baseRow({
        id: "row-1",
        status: "running",
        progressDone: 11,
        progressTotal: 12,
        msPerUnit: 65_000,
        lastProgressAt: new Date(realNow - 15 * 60_000),
      }),
    ];
    // The shape that broke it — index 0 and 1 land in the second parameter.
    const pointFree = snapshotFromRow as unknown as (
      row: (typeof rows)[number],
      index: number,
    ) => ReturnType<typeof snapshotFromRow>;
    const snaps = rows.map(pointFree);
    for (const s of snaps) {
      expect(s.msSinceProgress).toBeGreaterThan(14 * 60_000);
      expect(s.etaMs).toBeNull();
    }
  });
});
