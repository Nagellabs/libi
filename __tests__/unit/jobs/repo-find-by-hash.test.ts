import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";

describe("findJobByKindAndHash excludeTerminal", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  it("by default returns rows in any status (back-compat)", async () => {
    const { insertJob, findJobByKindAndHash, markCompleted } = await import("@/lib/jobs/repo");
    await insertJob({ id: "j1", kind: "k", clientKey: "ck-j1", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await markCompleted("j1", "{}");
    const row = await findJobByKindAndHash("k", "h");
    expect(row?.id).toBe("j1");
  });

  it("with excludeTerminal: true skips completed/failed/cancelled rows", async () => {
    const { insertJob, findJobByKindAndHash, markCompleted, markFailed, markCancelled } =
      await import("@/lib/jobs/repo");
    await insertJob({ id: "ok", kind: "k", clientKey: "ck-ok", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await markCompleted("ok", "{}");
    expect(await findJobByKindAndHash("k", "h", { excludeTerminal: true })).toBeNull();

    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    await insertJob({ id: "f", kind: "k", clientKey: "ck-f", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await markFailed("f", "boom");
    expect(await findJobByKindAndHash("k", "h", { excludeTerminal: true })).toBeNull();

    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    await insertJob({ id: "c", kind: "k", clientKey: "ck-c", paramsHash: "h", paramsJson: "{}", pieceId: null, fileId: null });
    await markCancelled("c");
    expect(await findJobByKindAndHash("k", "h", { excludeTerminal: true })).toBeNull();
  });

  it("with excludeTerminal: true still returns queued/running/cancel-requested rows", async () => {
    const { insertJob, findJobByKindAndHash, markRunning, markCancelRequested } =
      await import("@/lib/jobs/repo");
    await insertJob({ id: "q", kind: "k", clientKey: "ck-q", paramsHash: "queued", paramsJson: "{}", pieceId: null, fileId: null });
    await insertJob({ id: "r", kind: "k", clientKey: "ck-r", paramsHash: "run",    paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("r");
    await insertJob({ id: "cr", kind: "k", clientKey: "ck-cr", paramsHash: "cr",     paramsJson: "{}", pieceId: null, fileId: null });
    await markCancelRequested("cr");

    expect((await findJobByKindAndHash("k", "queued", { excludeTerminal: true }))?.id).toBe("q");
    expect((await findJobByKindAndHash("k", "run",    { excludeTerminal: true }))?.id).toBe("r");
    expect((await findJobByKindAndHash("k", "cr",     { excludeTerminal: true }))?.id).toBe("cr");
  });
});
