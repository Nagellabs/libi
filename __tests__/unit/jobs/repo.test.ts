import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";

describe("jobs/repo", () => {
  beforeEach(() => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
  });

  it("inserts a queued row and reads it back by id", async () => {
    const { insertJob, getJobById } = await import("@/lib/jobs/repo");
    const id = "job-1";
    await insertJob({
      id,
      kind: "tracking",
      clientKey: "ck-1",
      paramsHash: "abc",
      paramsJson: "{}",
      pieceId: null,
      fileId: null,
    });
    const row = await getJobById(id);
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("queued");
    expect(row?.progressDone).toBe(0);
  });

  it("finds an existing job by (kind, paramsHash) — case sensitive", async () => {
    const { insertJob, findJobByKindAndHash } = await import("@/lib/jobs/repo");
    await insertJob({ id: "j1", kind: "tracking", clientKey: "ck-j1", paramsHash: "aaa", paramsJson: "{}", pieceId: null, fileId: null });
    await insertJob({ id: "j2", kind: "proxy_gen", clientKey: "ck-j2", paramsHash: "aaa", paramsJson: "{}", pieceId: null, fileId: null });
    const t = await findJobByKindAndHash("tracking", "aaa");
    expect(t?.id).toBe("j1");
    const none = await findJobByKindAndHash("tracking", "different");
    expect(none).toBeNull();
  });

  it("updates progress fields atomically", async () => {
    const { insertJob, updateProgress, getJobById } = await import("@/lib/jobs/repo");
    await insertJob({ id: "p", kind: "tracking", clientKey: "ck-p", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await updateProgress("p", { done: 50, total: 100, unit: "frames", msPerUnit: 10 });
    const row = await getJobById("p");
    expect(row?.progressDone).toBe(50);
    expect(row?.progressTotal).toBe(100);
    expect(row?.progressUnit).toBe("frames");
    expect(row?.msPerUnit).toBe(10);
    expect(row?.lastProgressAt).toBeInstanceOf(Date);
  });

  it("transitions to a terminal status with completedAt set", async () => {
    const { insertJob, markCompleted, markFailed, getJobById } = await import("@/lib/jobs/repo");
    await insertJob({ id: "ok", kind: "k", clientKey: "ck-ok", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await markCompleted("ok", JSON.stringify({ samples: 3 }));
    const row1 = await getJobById("ok");
    expect(row1?.status).toBe("completed");
    expect(row1?.resultJson).toContain('"samples":3');
    expect(row1?.completedAt).toBeInstanceOf(Date);

    await insertJob({ id: "boom", kind: "k", clientKey: "ck-boom", paramsHash: "h2", paramsJson: "{}", pieceId: null, fileId: null });
    await markFailed("boom", "kaboom");
    const row2 = await getJobById("boom");
    expect(row2?.status).toBe("failed");
    expect(row2?.error).toBe("kaboom");
  });

  it("listRunning returns only currently-running rows", async () => {
    const { insertJob, markRunning, listRunning } = await import("@/lib/jobs/repo");
    await insertJob({ id: "a", kind: "tracking", clientKey: "ck-a", paramsHash: "1", paramsJson: "{}", pieceId: null, fileId: null });
    await insertJob({ id: "b", kind: "tracking", clientKey: "ck-b", paramsHash: "2", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("a");
    const running = await listRunning();
    expect(running.map((r) => r.id)).toEqual(["a"]);
    expect(running[0].lastProgressAt).toBeInstanceOf(Date);
  });

  it("listQueuedByKind sorts by createdAt ascending", async () => {
    const { insertJob, listQueuedByKind } = await import("@/lib/jobs/repo");
    await insertJob({ id: "old", kind: "tracking", clientKey: "ck-old", paramsHash: "1", paramsJson: "{}", pieceId: null, fileId: null });
    // Force ordering: small wait so the second row has a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await insertJob({ id: "new", kind: "tracking", clientKey: "ck-new", paramsHash: "2", paramsJson: "{}", pieceId: null, fileId: null });
    const queued = await listQueuedByKind("tracking");
    expect(queued.map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("cancel flow: markCancelRequested keeps completedAt null; markCancelled sets it", async () => {
    const { insertJob, markCancelRequested, markCancelled, getJobById } =
      await import("@/lib/jobs/repo");
    await insertJob({
      id: "c", kind: "tracking", clientKey: "ck-c", paramsHash: "h", paramsJson: "{}",
      pieceId: null, fileId: null,
    });

    await markCancelRequested("c");
    const mid = await getJobById("c");
    expect(mid?.status).toBe("cancel-requested");
    // Runner is still observing — completedAt MUST stay null so consumers don't
    // think the job is over yet.
    expect(mid?.completedAt).toBeNull();

    await markCancelled("c");
    const end = await getJobById("c");
    expect(end?.status).toBe("cancelled");
    expect(end?.completedAt).toBeInstanceOf(Date);
  });

  it("updatePartialPath sets partialPath on the row", async () => {
    const { insertJob, updatePartialPath, getJobById } = await import("@/lib/jobs/repo");
    await insertJob({
      id: "pp", kind: "tracking", clientKey: "ck-pp", paramsHash: "h", paramsJson: "{}",
      pieceId: null, fileId: null,
    });
    await updatePartialPath("pp", "/tmp/foo/state.json");
    const row = await getJobById("pp");
    expect(row?.partialPath).toBe("/tmp/foo/state.json");
  });
});
