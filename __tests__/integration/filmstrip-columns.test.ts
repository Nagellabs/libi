/**
 * Integration (schema smoke): the `files` table carries the new filmstrip_*
 * columns and a row round-trips them. Mirrors the proxy_* column shape.
 *
 * This proves the schema change AND the parallel hand-written CREATE TABLE in
 * `__tests__/helpers/test-db.ts` stay in lockstep — a divergence here breaks
 * every other filmstrip integration test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;

describe("files filmstrip_* columns", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
  });

  it("defaults filmstrip_status to 'idle' on a fresh row", () => {
    testDb
      .insert(files)
      .values({
        id: "f1",
        pieceId: "p1",
        filename: "clip.mp4",
        name: "clip",
        description: "",
        type: "video",
        storagePath: "p1/clip.mp4",
      })
      .run();
    const [row] = testDb.select().from(files).where(eq(files.id, "f1")).all();
    expect(row.filmstripStatus).toBe("idle");
    expect(row.filmstripFilename).toBeNull();
    expect(row.filmstripGeneratedAt).toBeNull();
    expect(row.filmstripFrames).toBeNull();
    expect(row.filmstripHeight).toBeNull();
  });

  it("round-trips a ready filmstrip with frame/height/timestamp values", () => {
    const generatedAt = new Date("2026-06-20T10:00:00.000Z");
    testDb
      .insert(files)
      .values({
        id: "f2",
        pieceId: "p1",
        filename: "shot.mp4",
        name: "shot",
        description: "",
        type: "video",
        storagePath: "p1/shot.mp4",
        filmstripFilename: "shot-filmstrip.jpg",
        filmstripStatus: "ready",
        filmstripGeneratedAt: generatedAt,
        filmstripFrames: 20,
        filmstripHeight: 48,
      })
      .run();
    const [row] = testDb.select().from(files).where(eq(files.id, "f2")).all();
    expect(row.filmstripFilename).toBe("shot-filmstrip.jpg");
    expect(row.filmstripStatus).toBe("ready");
    expect(row.filmstripGeneratedAt?.getTime()).toBe(generatedAt.getTime());
    expect(row.filmstripFrames).toBe(20);
    expect(row.filmstripHeight).toBe(48);
  });
});
