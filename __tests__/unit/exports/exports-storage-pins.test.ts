/**
 * Spec 2026-09-29 §A2 pins: a piece's exports live in `<storage>/<pieceId>/exports/`.
 * Duplicating a piece copies none of them; saving the composition never sweeps
 * them; deleting the piece removes the folder and the rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage, getStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { files, pieceExports, pieces } from "@/lib/db/schema/sqlite";
import { createExportRecord, markExportDone, setExportFile, doneExportForPath } from "@/lib/exports/store";
import { exportsDirFor } from "@/lib/exports/paths";

async function seedExport(pieceId: string, name: string): Promise<string> {
  const row = createExportRecord({ pieceId, name, source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
  const dir = await exportsDirFor(pieceId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${name}.mp4`);
  fs.writeFileSync(abs, "bytes");
  setExportFile(row.id, { name, relPath: `exports/${name}.mp4` });
  markExportDone(row.id, { sizeBytes: 5, durationSeconds: 1, width: 1080, height: 1920, backend: "ffmpeg-overlay", audioDecision: { purpose: null, excludedFileIds: [], carriesCopyrighted: false } });
  return abs;
}

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: "src" });
});
afterEach(() => {
  cleanupTempDir();
  resetTestDb();
  resetStorage();
});

describe("exports and the piece's storage", () => {
  it("duplicating a piece copies its assets but none of its exports", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const storage = await getStorage();
    getDb().insert(files).values({ id: crypto.randomUUID(), pieceId: "src", filename: "a.mp4", name: "a", description: "", type: "video", storagePath: "src/a.mp4", size: 4 }).run();
    await storage.save("src", "a.mp4", Buffer.from("data"), "video/mp4");
    await seedExport("src", "Promo");
    getDb().insert(pieces).values({ id: "dst", name: "src (copy)" }).run();

    await clonePieceInto("src", "dst", "draft");

    expect(fs.existsSync(storage.localPath("dst", "a.mp4"))).toBe(true);
    expect(fs.existsSync(await exportsDirFor("dst"))).toBe(false);
    expect(getDb().select().from(pieceExports).where(eq(pieceExports.pieceId, "dst")).all()).toEqual([]);
  });

  it("saving the composition leaves the exports folder alone", async () => {
    const { loadManifest, saveManifest } = await import("@/lib/composition/persistence");
    const abs = await seedExport("src", "Promo");
    await saveManifest("src", await loadManifest("src"));
    expect(fs.existsSync(abs)).toBe(true);
  });

  it("deleting the piece removes its exports folder and its export rows", async () => {
    const { deletePieceCompletely } = await import("@/lib/pieces/delete-piece");
    const abs = await seedExport("src", "Promo");
    await deletePieceCompletely("src");
    expect(fs.existsSync(abs)).toBe(false);
    expect(getDb().select().from(pieceExports).all()).toEqual([]);
  });

  it("doneExportForPath finds the record of a file, and nothing for a file libi did not export", async () => {
    const abs = await seedExport("src", "Promo");
    expect((await doneExportForPath(abs))?.name).toBe("Promo");
    expect(await doneExportForPath(path.join(path.dirname(abs), "Other.mp4"))).toBeNull();
  });
});
