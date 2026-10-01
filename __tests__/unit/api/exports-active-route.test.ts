import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { pieceExports } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { createExportRecord, getExportRecord, markExportDone, markExportRunning } from "@/lib/exports/store";
import { GET } from "@/app/api/exports/route";

const settings = { format: "mp4" as const, codec: "avc", fps: 30, width: 1080, height: 1920 };

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: "p1", name: "One" });
  seedPiece(getDb() as never, { id: "p2", name: "Two" });
});
afterEach(() => {
  cleanupTempDir();
  resetTestDb();
  resetStorage();
});

type Row = { id: string; pieceName: string; status: string };

describe("GET /api/exports", () => {
  it("answers every queued or running export, across pieces, with the piece's name", async () => {
    const a = createExportRecord({ pieceId: "p1", name: "A", source: "user", settings });
    const b = createExportRecord({ pieceId: "p2", name: "B", source: "agent", settings });
    markExportRunning(b.id, "job-b");
    const done = createExportRecord({ pieceId: "p1", name: "C", source: "user", settings });
    markExportDone(done.id, { sizeBytes: 1, durationSeconds: 1, width: 1080, height: 1920, backend: "x", audioDecision: { purpose: null, excludedFileIds: [], carriesCopyrighted: false } });
    const { exports } = (await (await GET()).json()) as { exports: Row[] };
    expect(exports.map((e) => [e.id, e.pieceName, e.status])).toEqual([
      [a.id, "One", "queued"],
      [b.id, "Two", "running"],
    ]);
  });

  it("is effect-free: a lost export drops out of the answer but its row and the SSE stay untouched", async () => {
    const lost = createExportRecord({ pieceId: "p1", name: "Lost", source: "user", settings });
    getDb()
      .update(pieceExports)
      .set({ queuedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(pieceExports.id, lost.id))
      .run();
    const emitted = vi.fn();
    navigationEmitter.on("refresh_query", emitted);
    try {
      const { exports } = (await (await GET()).json()) as { exports: Row[] };
      expect(exports).toEqual([]);
      expect(getExportRecord(lost.id)?.status).toBe("queued");
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      navigationEmitter.off("refresh_query", emitted);
    }
  });
});
