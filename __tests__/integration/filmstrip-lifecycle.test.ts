/**
 * Integration: filmstrip lifecycle drop + LRU select + delete cascade.
 *
 * - dropFilmstripFile unlinks the sprite + clears the filmstrip_* columns.
 * - selectFilmstripsToEvict picks oldest non-in-use first, under budget.
 * - deleteFile() drops the filmstrip alongside the proxy (cascade).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { dropFilmstripFile } from "@/lib/filmstrip/lifecycle";
import {
  selectFilmstripsToEvict,
  type FilmstripEntry,
} from "@/lib/filmstrip/lru";

const PIECE = "p1";

function seedVideoWithFilmstrip(id: string, spriteName: string) {
  const pieceDir = path.join(getLibiStorageDir(), PIECE);
  fs.mkdirSync(pieceDir, { recursive: true });
  fs.writeFileSync(path.join(pieceDir, spriteName), Buffer.from("SPRITE"));
  fs.writeFileSync(path.join(pieceDir, `${id}.mp4`), Buffer.from("VIDEO"));
  getDb()
    .insert(files)
    .values({
      id,
      pieceId: PIECE,
      filename: `${id}.mp4`,
      name: id,
      description: "",
      type: "video",
      storagePath: `${PIECE}/${id}.mp4`,
      contentType: "video/mp4",
      filmstripFilename: spriteName,
      filmstripStatus: "ready",
      filmstripFrames: 20,
      filmstripHeight: 48,
      filmstripGeneratedAt: new Date(),
    })
    .run();
}

describe("filmstrip lifecycle", () => {
  beforeEach(() => {
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb(), { id: PIECE });
  });
  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
    vi.restoreAllMocks();
  });

  it("dropFilmstripFile unlinks the sprite + clears columns", () => {
    seedVideoWithFilmstrip("f1", "f1-filmstrip.jpg");
    const spritePath = path.join(getLibiStorageDir(), PIECE, "f1-filmstrip.jpg");
    expect(fs.existsSync(spritePath)).toBe(true);

    dropFilmstripFile("f1", "user");

    expect(fs.existsSync(spritePath)).toBe(false);
    const [row] = getDb().select().from(files).where(eq(files.id, "f1")).all();
    expect(row.filmstripFilename).toBeNull();
    expect(row.filmstripStatus).toBe("idle");
    expect(row.filmstripGeneratedAt).toBeNull();
    expect(row.filmstripFrames).toBeNull();
    expect(row.filmstripHeight).toBeNull();
  });

  it("dropFilmstripFile is a no-op on a never-generated row", () => {
    getDb()
      .insert(files)
      .values({
        id: "f-none",
        pieceId: PIECE,
        filename: "n.mp4",
        name: "n",
        description: "",
        type: "video",
        storagePath: `${PIECE}/n.mp4`,
      })
      .run();
    expect(() => dropFilmstripFile("f-none")).not.toThrow();
  });

  it("selectFilmstripsToEvict drops oldest non-in-use first under budget", () => {
    const entries: FilmstripEntry[] = [
      { fileId: "old", bytes: 100, generatedAt: 1000, inUse: false },
      { fileId: "new", bytes: 100, generatedAt: 5000, inUse: false },
      { fileId: "open", bytes: 100, generatedAt: 500, inUse: true },
    ];
    // Budget 200 → must evict 100 bytes. "open" is in-use (protected); "old"
    // is the oldest non-in-use → evicted.
    expect(selectFilmstripsToEvict(entries, 200)).toEqual(["old"]);
  });

  it("selectFilmstripsToEvict returns nothing when under budget", () => {
    const entries: FilmstripEntry[] = [
      { fileId: "a", bytes: 10, generatedAt: 1, inUse: false },
    ];
    expect(selectFilmstripsToEvict(entries, 1000)).toEqual([]);
  });

  it("deleteFile cascade drops the filmstrip sprite", async () => {
    // deleteFile pulls in storage + composition modules; load it here so the
    // temp storage env is already set.
    const { deleteFile } = await import("@/lib/files/delete-file");
    seedVideoWithFilmstrip("f2", "f2-filmstrip.jpg");
    const spritePath = path.join(getLibiStorageDir(), PIECE, "f2-filmstrip.jpg");
    expect(fs.existsSync(spritePath)).toBe(true);

    const res = await deleteFile("f2");
    expect(res.success).toBe(true);
    expect(fs.existsSync(spritePath)).toBe(false);
    const rows = getDb().select().from(files).where(eq(files.id, "f2")).all();
    expect(rows.length).toBe(0);
  });
});
