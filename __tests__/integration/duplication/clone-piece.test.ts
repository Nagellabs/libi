import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces, files, assetFolders, jobs } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dup-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clonePieceInto", () => {
  it("copies files, asset folders, manifest with rewritten fileIds, and is independent", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const { saveManifest } = await import("@/lib/composition/persistence");
    const db = getDb();
    const storage = await getStorage();

    // --- source piece with one file inside an asset folder, used by a video scene ---
    seedPiece(db as never, { id: "src" });
    const fileId = crypto.randomUUID();
    const folderId = crypto.randomUUID();
    db.insert(assetFolders).values({ id: folderId, pieceId: "src", name: "Clips" }).run();
    db.insert(files).values({
      id: fileId, pieceId: "src", folderId, filename: "clip.mp4", name: "clip",
      description: "", type: "video", storagePath: "src/clip.mp4", size: 4,
    }).run();
    await storage.save("src", "clip.mp4", Buffer.from("data"), "video/mp4");
    await saveManifest("src", {
      width: 1920, height: 1080, fps: 30, 
      audioClips: [],
      overlays: [{
        id: "ov1", kind: "video", fileId, displayName: "S",
        startTime: 0, duration: 5, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
      }],
    });

    // --- shell destination piece ---
    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();

    await clonePieceInto("src", "dst", "draft");

    // file row copied, repointed, new id
    const dstFiles = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(dstFiles).toHaveLength(1);
    expect(dstFiles[0].id).not.toBe(fileId);
    expect(dstFiles[0].storagePath).toBe(`dst/${dstFiles[0].filename}`);
    // bytes copied
    expect(await storage.exists("dst", dstFiles[0].filename)).toBe(true);
    // asset folder cloned with a fresh id + the file remapped into it
    const dstFolders = db.select().from(assetFolders).where(eq(assetFolders.pieceId, "dst")).all();
    expect(dstFolders).toHaveLength(1);
    expect(dstFolders[0].name).toBe("Clips");
    expect(dstFolders[0].id).not.toBe(folderId);
    expect(dstFiles[0].folderId).toBe(dstFolders[0].id);
    // manifest fileId rewritten
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest("dst");
    expect((m.overlays![0] as { fileId: string }).fileId).toBe(dstFiles[0].id);
    // copy starts committed
    expect(db.select().from(pieces).where(eq(pieces.id, "dst")).get()?.hasDraft).toBeFalsy();
    // independence: deleting the copy's file leaves the source file intact
    await storage.delete("dst", dstFiles[0].filename);
    expect(await storage.exists("src", "clip.mp4")).toBe(true);
  });

  it("rolls back the shell piece on failure", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const db = getDb();
    db.insert(pieces).values({ id: "dst2", name: "x" }).run();
    // source does not exist → clone throws, rollback removes the shell
    await expect(clonePieceInto("missing-src", "dst2", "draft")).rejects.toThrow();
    expect(db.select().from(pieces).where(eq(pieces.id, "dst2")).all()).toEqual([]);
  });

  it("rollback detaches the piece_dup job so it survives as a retryable row", async () => {
    // `jobs.pieceId` has ON DELETE CASCADE → deleting the shell piece would
    // also delete the job row, leaving JobManager unable to mark it `failed`.
    // The rollback must null out `jobs.pieceId` first so the job row survives.
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const db = getDb();
    db.insert(pieces).values({ id: "dst3", name: "x" }).run();
    db.insert(jobs).values({
      id: "job-dst3",
      kind: "piece_dup",
      clientKey: "k",
      status: "running",
      paramsHash: "h",
      paramsJson: "{}",
      pieceId: "dst3",
    }).run();

    await expect(clonePieceInto("missing-src", "dst3", "draft")).rejects.toThrow();

    // shell piece gone …
    expect(db.select().from(pieces).where(eq(pieces.id, "dst3")).all()).toEqual([]);
    // … but the job row survives, detached from the deleted piece.
    const job = db.select().from(jobs).where(eq(jobs.id, "job-dst3")).get();
    expect(job).toBeDefined();
    expect(job?.pieceId).toBeNull();
  });
});
