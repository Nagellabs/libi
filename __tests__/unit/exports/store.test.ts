import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { jobs, pieceExports, pieces } from "@/lib/db/schema/sqlite";
import { exportLogger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import {
  LOST_EXPORT_MESSAGE,
  NO_AUDIO_DECISION_MESSAGE,
  RESTARTED_EXPORT_MESSAGE,
  createExportRecord,
  deleteExportRecord,
  getExportRecord,
  getExportView,
  listExportRecords,
  listExportViews,
  markExportCancelled,
  markExportDone,
  markExportFailed,
  markExportRunning,
  recoverOrphanedExports,
  setExportFile,
  setExportJob,
  staleStatus,
  uniqueExportName,
} from "@/lib/exports/store";
import { exportsDirFor } from "@/lib/exports/paths";

const PIECE = "p-store";
const SETTINGS = { format: "mp4" as const, codec: "avc", fps: 30, width: 1080, height: 1920, quality: "source", graphicsQuality: "4k" };

function create(name = "Promo", extra: Partial<Parameters<typeof createExportRecord>[0]> = {}) {
  return createExportRecord({ pieceId: PIECE, name, source: "user", settings: SETTINGS, ...extra });
}

async function writeExportFile(fileName: string): Promise<string> {
  const dir = await exportsDirFor(PIECE);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, "bytes");
  return abs;
}

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: PIECE, name: "My Piece" });
});
afterEach(() => {
  cleanupTempDir();
  resetTestDb();
  resetStorage();
  vi.restoreAllMocks();
});

describe("createExportRecord", () => {
  it("creates a queued row with an exp_ id, the aspect of the target frame, and tells the UI", () => {
    const emit = vi.spyOn(navigationEmitter, "emit");
    const row = create();
    expect(row.id).toMatch(/^exp_[0-9a-f]{32}$/);
    expect(row).toMatchObject({ pieceId: PIECE, name: "Promo", status: "queued", aspect: "9:16", container: "mp4", source: "user", relPath: null });
    expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: "exports", pieceId: PIECE, exportId: row.id, status: "queued" });
  });

  it("lists a piece's rows oldest first", () => {
    const a = create("A", { id: "exp_a" });
    getDb().update(pieceExports).set({ queuedAt: new Date(1000) }).where(eq(pieceExports.id, a.id)).run();
    const b = create("B", { id: "exp_b" });
    getDb().update(pieceExports).set({ queuedAt: new Date(2000) }).where(eq(pieceExports.id, b.id)).run();
    expect(listExportRecords(PIECE).map((r) => r.id)).toEqual(["exp_a", "exp_b"]);
  });
});

describe("uniqueExportName", () => {
  it("keeps a free stem, strips the same extension, and sanitizes", async () => {
    expect(await uniqueExportName(PIECE, "Summer promo.mp4", "mp4")).toBe("Summer promo");
    expect(await uniqueExportName(PIECE, "a/b", "mp4")).toBe("a_b");
  });

  it("suffixes against rows (case-insensitive) and files on disk, ignoring cancelled rows", async () => {
    create("Promo");
    expect(await uniqueExportName(PIECE, "promo", "mp4")).toBe("promo-1");
    await writeExportFile("promo-1.mp4");
    expect(await uniqueExportName(PIECE, "Promo", "mp4")).toBe("Promo-2");
    const cancelled = create("Gone");
    markExportCancelled(cancelled.id);
    expect(await uniqueExportName(PIECE, "Gone", "mp4")).toBe("Gone");
  });

  it("does not count the row it is renaming", async () => {
    const row = create("Promo");
    await writeExportFile("Promo.mp4");
    expect(await uniqueExportName(PIECE, "Promo", "mp4", { exceptId: row.id })).toBe("Promo");
  });
});

describe("the lifecycle", () => {
  it("running → file claimed → done fills the facts, and the view resolves the file", async () => {
    const row = create();
    expect(markExportRunning(row.id, "job-1")).toBe(true);
    expect(getExportRecord(row.id)).toMatchObject({ status: "running", jobId: "job-1" });
    const abs = await writeExportFile("Promo.mp4");
    setExportFile(row.id, { name: "Promo", relPath: "exports/Promo.mp4" });
    expect(
      markExportDone(row.id, {
        sizeBytes: 5, durationSeconds: 3, width: 1920, height: 1080, backend: "ffmpeg-overlay",
        audioDecision: { purpose: "social", excludedFileIds: ["song"], carriesCopyrighted: false },
      }),
    ).toBe(true);
    const view = await getExportView(row.id);
    expect(view).toMatchObject({
      status: "done", missing: false, path: abs, fileName: "Promo.mp4", sizeBytes: 5, durationSec: 3,
      width: 1920, height: 1080, aspect: "16:9", backend: "ffmpeg-overlay", purpose: "social",
      excludedFileIds: ["song"], carriesCopyrighted: false, pieceName: "My Piece", progress: null, waiting: null,
    });
  });

  it("a done row whose file is gone reads as missing, never dropped", async () => {
    const row = create();
    setExportFile(row.id, { name: "Promo", relPath: "exports/Promo.mp4" });
    markExportDone(row.id, { sizeBytes: 1, durationSeconds: 1, width: 1080, height: 1920, backend: "stream-copy-trim", audioDecision: { purpose: null, excludedFileIds: [], carriesCopyrighted: false } });
    const [view] = await listExportViews(PIECE);
    expect(view).toMatchObject({ status: "done", missing: true });
  });

  it("failed keeps its message; cancelled is recorded; a write to a deleted row reports false", () => {
    const a = create("A");
    markExportFailed(a.id, "Composition cannot be exported: nothing to export");
    expect(getExportRecord(a.id)).toMatchObject({ status: "failed", error: "Composition cannot be exported: nothing to export" });
    const b = create("B");
    markExportCancelled(b.id);
    expect(getExportRecord(b.id)?.status).toBe("cancelled");
    expect(deleteExportRecord(b.id)?.id).toBe(b.id);
    expect(markExportDone(b.id, { sizeBytes: 1, durationSeconds: 1, width: 1, height: 1, backend: "x", audioDecision: { purpose: null, excludedFileIds: [], carriesCopyrighted: false } })).toBe(false);
  });

  it("a failed or cancelled row lets go of its file path (the runner removed the partial; the name is free)", () => {
    const a = create("A");
    setExportFile(a.id, { name: "A", relPath: "exports/A.mp4" });
    markExportFailed(a.id, "boom");
    expect(getExportRecord(a.id)).toMatchObject({ status: "failed", relPath: null });
    const b = create("B");
    setExportFile(b.id, { name: "B", relPath: "exports/B.mp4" });
    markExportCancelled(b.id);
    expect(getExportRecord(b.id)).toMatchObject({ status: "cancelled", relPath: null });
  });

  it("refuses a done write with no audio decision — it would read as song-free — and says so in the log", () => {
    const error = vi.spyOn(exportLogger, "error");
    const row = create();
    expect(() => markExportDone(row.id, { sizeBytes: 1, durationSeconds: 1, width: 1, height: 1, backend: "x" } as never)).toThrow(NO_AUDIO_DECISION_MESSAGE);
    expect(getExportRecord(row.id)?.status).toBe("queued");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ op: "record_done_refused", exportId: row.id }), "export.record_done_refused");
  });

  it("deleting the piece takes its rows with it (FK cascade)", () => {
    create();
    getDb().delete(pieces).where(eq(pieces.id, PIECE)).run();
    expect(getDb().select().from(pieceExports).all()).toEqual([]);
  });
});

describe("reconciling with the job", () => {
  const row = (status: "queued" | "running", queuedAt = 0) => ({ status, queuedAt: new Date(queuedAt), jobId: "job-1" });

  it("follows a cancelled or failed job, and leaves a live one alone", () => {
    expect(staleStatus(row("queued"), { status: "cancelled", error: null }, 10)).toEqual({ status: "cancelled", error: null });
    expect(staleStatus(row("running"), { status: "failed", error: "boom" }, 10)).toEqual({ status: "failed", error: "boom" });
    expect(staleStatus(row("running"), { status: "running", error: null }, 10)).toBeNull();
    expect(staleStatus({ ...row("running"), status: "done" as never }, null, 10)).toBeNull();
  });

  it("a job that is gone fails the row only after a minute's grace", () => {
    expect(staleStatus(row("queued", 0), null, 30_000)).toBeNull();
    expect(staleStatus(row("queued", 0), null, 61_000)).toEqual({ status: "failed", error: LOST_EXPORT_MESSAGE });
  });

  it("a read reconciles the VIEW only — the derived status is returned but never persisted, and reading never emits", async () => {
    const a = create("A");
    markExportRunning(a.id, "job-a");
    getDb().insert(jobs).values({ id: "job-a", kind: "export", status: "cancelled", paramsHash: "a", paramsJson: "{}" }).run();
    const b = create("B");
    setExportJob(b.id, "job-b");
    getDb().insert(jobs).values({ id: "job-b", kind: "export", status: "running", paramsHash: "b", paramsJson: "{}", progressDone: 0, progressTotal: 1, progressUnit: "waiting" }).run();

    const emit = vi.spyOn(navigationEmitter, "emit");
    const views = await listExportViews(PIECE);
    expect(views.find((v) => v.id === a.id)?.status).toBe("cancelled");
    expect(views.find((v) => v.id === b.id)).toMatchObject({
      status: "queued",
      progress: { done: 0, total: 1, unit: "waiting" },
      waiting: { reason: "queue", message: "Waiting for another export to finish" },
    });
    // The row itself is untouched by the read — only the runner, removeExport
    // and boot recovery write a reconciled status.
    expect(getExportRecord(a.id)?.status).toBe("running");
    expect(emit).not.toHaveBeenCalled();

    // getExportView reconciles the same way, and is just as read-only.
    expect((await getExportView(a.id))?.status).toBe("cancelled");
    expect(getExportRecord(a.id)?.status).toBe("running");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("the waiting line", () => {
  const waitingJob = (id: string) =>
    getDb().insert(jobs).values({ id, kind: "export", status: "running", paramsHash: id, paramsJson: "{}", progressDone: 0, progressTotal: 1, progressUnit: "waiting" }).run();

  it("a QUEUED row whose job says 'waiting' reads as waiting", async () => {
    const q = create("Q");
    setExportJob(q.id, "job-q");
    waitingJob("job-q");
    expect((await getExportView(q.id))?.waiting).toEqual({ reason: "queue", message: "Waiting for another export to finish" });
  });

  it("a RUNNING row never does: once admitted, a stale 'waiting' unit (the progress debounce) is not the truth", async () => {
    const r = create("R");
    markExportRunning(r.id, "job-r");
    waitingJob("job-r");
    const view = await getExportView(r.id);
    expect(view).toMatchObject({ status: "running", waiting: null });
    expect(view?.progress?.unit).toBe("waiting");
  });
});

describe("recoverOrphanedExports", () => {
  it("fails rows a previous process left queued/running and removes their placeholder file", async () => {
    const old = create("Old");
    markExportRunning(old.id, "job-old");
    const abs = await writeExportFile("Old.mp4");
    setExportFile(old.id, { name: "Old", relPath: "exports/Old.mp4" });
    getDb().update(pieceExports).set({ queuedAt: new Date(1000) }).where(eq(pieceExports.id, old.id)).run();
    const fresh = create("Fresh");
    getDb().update(pieceExports).set({ queuedAt: new Date(5000) }).where(eq(pieceExports.id, fresh.id)).run();

    expect(await recoverOrphanedExports(3000)).toBe(1);
    expect(getExportRecord(old.id)).toMatchObject({ status: "failed", error: RESTARTED_EXPORT_MESSAGE, relPath: null });
    expect(fs.existsSync(abs)).toBe(false);
    expect(getExportRecord(fresh.id)?.status).toBe("queued");
  });
});
