import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

const PIECE_ID = "piece-cascade-1";
const FILE_ID = "file-cascade-1";
let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-cascade-"));
  process.env.LIBI_HOME = tmp;
  db = createTestDb();
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID,
    pieceId: PIECE_ID,
    filename: "a.mp4",
    name: "a",
    description: "",
    type: "video",
    storagePath: "/tmp/a.mp4",
    size: 0,
  });
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("track cascade on file delete (via removeReferencesToFile + repo)", () => {
  it("removeReferencesToFile drops tracked overlays whose content.fileId matches", async () => {
    const { addOverlayToManifest, loadManifest, removeReferencesToFile } = await import(
      "@/lib/composition/persistence"
    );

    await addOverlayToManifest(PIECE_ID, {
      id: "ov-cascade",
      kind: "tracked",
      startTime: 0,
      duration: 5,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 10,
      opacity: 1,
      trackId: "t-cascade",
      content: { kind: "image", fileId: FILE_ID },
      fit: "tight",
      scale: 1,
      smoothing: "linear",
    });

    await removeReferencesToFile(PIECE_ID, FILE_ID);

    const manifest = await loadManifest(PIECE_ID);
    const stillThere = (manifest.overlays ?? []).find((o) => o.id === "ov-cascade");
    expect(stillThere).toBeUndefined();
  });

  it("FK cascade + repo delete: tracks DB rows removed when file is deleted", async () => {
    const { insertTrackRow, listTracksByFile, deleteTrackRow } = await import(
      "@/lib/tracking/repo"
    );
    const {
      writeTrack,
      readTrack,
      deleteTrack: deleteTrackSidecar,
    } = await import("@/lib/tracking/storage");

    await insertTrackRow(db, {
      id: "t-cascade",
      fileId: FILE_ID,
      method: "mediapipe-face",
      framerate: 30,
      durationSec: 1,
      sampleCount: 30,
    });
    await writeTrack(PIECE_ID, {
      id: "t-cascade",
      fileId: FILE_ID,
      method: "mediapipe-face",
      framerate: 30,
      durationSec: 1,
      samples: [],
    });

    // Simulate the DELETE handler logic — repo + sidecar cleanup, then file row deletion.
    const trackRows = await listTracksByFile(db, FILE_ID);
    for (const t of trackRows) {
      await deleteTrackSidecar(PIECE_ID, t.id);
      await deleteTrackRow(db, t.id);
    }
    await db.delete(files).where(eq(files.id, FILE_ID));

    expect(await readTrack(PIECE_ID, "t-cascade")).toBeNull();
    const remaining = await listTracksByFile(db, FILE_ID);
    expect(remaining).toHaveLength(0);
  });
});
