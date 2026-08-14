import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import {
  findRunningByHash,
  findTerminalByHash,
  insertJob,
  markRunning,
  markCompleted,
  markFailed,
} from "@/lib/jobs/repo";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
import { getDb } from "@/lib/db/client";

describe("findRunningByHash / findTerminalByHash", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
  });

  it("findRunningByHash returns the queued job before it starts", async () => {
    await insertJob({ id: "j1", kind: "k", clientKey: "ck-j1", paramsHash: "h1", paramsJson: "{}", pieceId: null, fileId: null });
    const r = await findRunningByHash("k", "h1");
    expect(r?.id).toBe("j1");
  });

  it("findRunningByHash returns the running job", async () => {
    await insertJob({ id: "j2", kind: "k", clientKey: "ck-j2", paramsHash: "h2", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j2");
    expect((await findRunningByHash("k", "h2"))?.id).toBe("j2");
  });

  it("findRunningByHash returns null once the job completes", async () => {
    await insertJob({ id: "j3", kind: "k", clientKey: "ck-j3", paramsHash: "h3", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j3");
    await markCompleted("j3", "{}");
    expect(await findRunningByHash("k", "h3")).toBeNull();
  });

  it("findRunningByHash distinguishes by paramsHash", async () => {
    await insertJob({ id: "j4", kind: "k", clientKey: "ck-j4", paramsHash: "h4", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j4");
    expect(await findRunningByHash("k", "different-hash")).toBeNull();
  });

  it("findTerminalByHash returns the most-recent completed job", async () => {
    await insertJob({ id: "j5", kind: "k", clientKey: "ck-j5", paramsHash: "h5", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j5");
    await markCompleted("j5", "{\"out\":\"first\"}");

    // Wait a millisecond so completedAt differs
    await new Promise((r) => setTimeout(r, 5));

    await insertJob({ id: "j6", kind: "k", clientKey: "ck-j6", paramsHash: "h5", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j6");
    await markCompleted("j6", "{\"out\":\"second\"}");

    const latest = await findTerminalByHash("k", "h5");
    expect(latest?.id).toBe("j6");
  });

  it("findTerminalByHash includes failed jobs", async () => {
    await insertJob({ id: "j7", kind: "k", clientKey: "ck-j7", paramsHash: "h7", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j7");
    await markFailed("j7", "boom");
    const r = await findTerminalByHash("k", "h7");
    expect(r?.id).toBe("j7");
    expect(r?.status).toBe("failed");
  });

  it("findTerminalByHash returns null when only running jobs exist", async () => {
    await insertJob({ id: "j8", kind: "k", clientKey: "ck-j8", paramsHash: "h8", paramsJson: "{}", pieceId: null, fileId: null });
    await markRunning("j8");
    expect(await findTerminalByHash("k", "h8")).toBeNull();
  });
});
