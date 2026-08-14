import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { insertTrackRow, getTrackRow, listTracksByFile } from "@/lib/tracking/repo";

let db: ReturnType<typeof createTestDb>;
const PIECE_ID = "piece-1";
const FILE_ID = "file-1";

beforeEach(async () => {
  db = createTestDb();
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID, pieceId: PIECE_ID, filename: "a.mp4", name: "a", description: "",
    type: "video", storagePath: "/tmp/a.mp4", size: 0,
  });
});
afterEach(() => resetTestDb());

describe("tracks repo", () => {
  it("inserts and gets a track row", async () => {
    await insertTrackRow(db, {
      id: "trk-1", fileId: FILE_ID, label: "lisa", method: "mediapipe-face",
      framerate: 30, durationSec: 1.0, sampleCount: 30,
    });
    const row = await getTrackRow(db, "trk-1");
    expect(row?.label).toBe("lisa");
    expect(row?.sampleCount).toBe(30);
  });

  it("lists tracks by fileId", async () => {
    await insertTrackRow(db, { id: "a", fileId: FILE_ID, method: "mediapipe-face", framerate: 30, durationSec: 1, sampleCount: 1 });
    await insertTrackRow(db, { id: "b", fileId: FILE_ID, method: "mediapipe-object", framerate: 30, durationSec: 1, sampleCount: 1 });
    const rows = await listTracksByFile(db, FILE_ID);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("delete cascades when file is deleted (FK pragma on)", async () => {
    await insertTrackRow(db, { id: "x", fileId: FILE_ID, method: "manual", framerate: 1, durationSec: 0, sampleCount: 0 });
    await db.delete(files).where(eq(files.id, FILE_ID));
    const rows = await listTracksByFile(db, FILE_ID);
    expect(rows).toHaveLength(0);
  });
});
