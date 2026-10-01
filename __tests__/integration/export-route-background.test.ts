import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

const run = vi.hoisted(() => ({ reject: null as unknown }));
vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    enqueue: async () => ({ status: "new", jobId: "job-bg" }),
    runToCompletion: async () => {
      throw run.reject;
    },
  }),
}));
const logs = vi.hoisted(() => ({ info: [] as unknown[][], warn: [] as unknown[][] }));
vi.mock("@/lib/logger", async (orig) => {
  const mod = await orig<typeof import("@/lib/logger")>();
  return {
    ...mod,
    exportLogger: {
      info: (...a: unknown[]) => logs.info.push(a),
      warn: (...a: unknown[]) => logs.warn.push(a),
      error: () => {},
      debug: () => {},
    },
  };
});
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));

import { getDb } from "@/lib/db/client";
import { CancelledError } from "@/lib/jobs/types";
import { POST } from "@/app/api/export/route";

const PIECE = "p-bg";
const post = () => POST(new Request("http://test/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pieceId: PIECE }) }));
const ops = (list: unknown[][]) => list.map((a) => (a[0] as { op?: string }).op);

describe("POST /api/export — the background run's end", () => {
  beforeEach(() => {
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE, name: "Piece" });
    logs.info.length = 0;
    logs.warn.length = 0;
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
  });

  it("a user cancel logs info background_cancelled, with no err and no warning", async () => {
    run.reject = new CancelledError("job-bg");
    expect((await post()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(ops(logs.warn)).not.toContain("background_failed");
    const cancelled = logs.info.find((a) => (a[0] as { op?: string }).op === "background_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled![0]).toMatchObject({ jobId: "job-bg" });
    expect(cancelled![0]).not.toHaveProperty("err");
  });

  it("a real failure still warns background_failed with the message", async () => {
    run.reject = new Error("ffmpeg exploded");
    expect((await post()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const failed = logs.warn.find((a) => (a[0] as { op?: string }).op === "background_failed");
    expect(failed![0]).toMatchObject({ jobId: "job-bg", err: "ffmpeg exploded" });
    expect(ops(logs.info)).not.toContain("background_cancelled");
  });
});
