/**
 * deleteFile() removes the file from disk + DB + drops its proxy +
 * cascades references on the composition. Used by both the HTTP route
 * and the MCP tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers/test-db";
import { files, pieces } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

let storageRoot: string;
const PIECE_ID = "p_df";
const FILE_ID = "f_df";

// Mock storage to use the current temp dir (avoids singleton caching across tests)
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

// Mock proxy lifecycle — dropProxyFile is a no-op in tests
vi.mock("@/lib/proxy/lifecycle", () => ({
  dropProxyFile: () => undefined,
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-df-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  writeFileSync(join(storageRoot, "storage", PIECE_ID, "v.mp4"), Buffer.from([1, 2, 3, 4]));
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      width: 1920, height: 1080, fps: 30,
      overlays: [{
        id: "ov1", kind: "video", fileId: FILE_ID,
        startTime: 0, duration: 5, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
      }],
      audioClips: [{ id: "c1", kind: "inline", linkedOverlayId: "ov1", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    }),
  );

  const db = createTestDb();
  db.insert(pieces).values({ id: PIECE_ID, name: "p", description: "", nameSetByUser: false }).run();
  db.insert(files).values({
    id: FILE_ID, pieceId: PIECE_ID, filename: "v.mp4", name: "v.mp4", description: "",
    type: "video", storagePath: "test", size: 4, mediaDuration: 5, hasAudio: true,
  }).run();
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("deleteFile", () => {
  it("erases the file from disk, removes its DB row, cascades to overlays + audio clips", async () => {
    const { deleteFile } = await import("@/lib/files/delete-file");
    const result = await deleteFile(FILE_ID);
    expect(result.success).toBe(true);
    expect(result.removedOverlays).toEqual(["ov1"]);
    expect(result.removedClips).toEqual(["c1"]);

    expect(existsSync(join(storageRoot, "storage", PIECE_ID, "v.mp4"))).toBe(false);

    const db = createTestDb();
    const remaining = db.select().from(files).where(eq(files.id, FILE_ID)).all();
    expect(remaining).toHaveLength(0);
  });

  it("returns success: false when the file is missing", async () => {
    const { deleteFile } = await import("@/lib/files/delete-file");
    const result = await deleteFile("nonexistent");
    expect(result.success).toBe(false);
  });

  it("succeeds and skips composition cascade for global files (pieceId=null)", async () => {
    // Seed a global file (pieceId null) — no composition to cascade through.
    const db = createTestDb();
    db.insert(files).values({
      id: "global-1", pieceId: null, filename: "g.mp3", name: "g.mp3", description: "",
      type: "audio", storagePath: "_global", size: 1024, hasAudio: true,
    }).run();
    // Drop the file from disk in our temp storage tree
    mkdirSync(join(storageRoot, "storage", "_global"), { recursive: true });
    writeFileSync(join(storageRoot, "storage", "_global", "g.mp3"), Buffer.from([1, 2]));

    const { deleteFile } = await import("@/lib/files/delete-file");
    const result = await deleteFile("global-1");
    expect(result.success).toBe(true);
    expect(result.removedOverlays).toEqual([]);
    expect(result.removedClips).toEqual([]);
    expect(existsSync(join(storageRoot, "storage", "_global", "g.mp3"))).toBe(false);
  });
});
