import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";

let tmp: string;
let db: ReturnType<typeof createTestDb>;

const PIECE_ID = "piece-st-1";
const FILE_ID = "file-st-1";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "libi-save-track-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getDb).mockReturnValue(db as any);

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
    mediaWidth: 1920,
    mediaHeight: 1080,
  });
});

afterEach(async () => {
  vi.resetModules();
  resetTestDb();
  delete process.env.LIBI_HOME;
  await rm(tmp, { recursive: true, force: true });
});

describe("saveTrackSamples", () => {
  it("writes DB row + JSON sidecar for a happy-path call", async () => {
    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    const { getTrackRow } = await import("@/lib/tracking/repo");
    const { readTrack } = await import("@/lib/tracking/storage");

    const result = await saveTrackSamples({
      trackId: "trk-abc123",
      fileId: FILE_ID,
      samples: [
        { t: 0, x: 10, y: 20, w: 30, h: 40, confidence: 0.9, visible: true },
        { t: 1, x: 11, y: 21, w: 31, h: 41, confidence: 0.8, visible: true },
      ],
      framerate: 30,
      method: "mediapipe-face",
      label: "subject-a",
      anchors: [{ fileId: FILE_ID, time: 0, bbox: [10, 10, 50, 50] }],
    });

    expect(result.trackId).toBe("trk-abc123");
    expect(result.sampleCount).toBe(2);
    expect(result.durationSec).toBe(1); // last sample t
    expect(result.pieceId).toBe(PIECE_ID);

    // DB row persisted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getTrackRow(db as any, "trk-abc123");
    expect(row).not.toBeNull();
    expect(row?.label).toBe("subject-a");
    expect(row?.sampleCount).toBe(2);
    expect(row?.durationSec).toBe(1);

    // JSON sidecar persisted
    const track = await readTrack(PIECE_ID, "trk-abc123");
    expect(track).not.toBeNull();
    expect(track?.samples).toHaveLength(2);
    expect(track?.samples[0].x).toBe(10);
    expect(track?.anchors?.[0].fileId).toBe(FILE_ID);
  });

  it("throws 'file not found' when fileId does not exist", async () => {
    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    await expect(
      saveTrackSamples({
        trackId: "trk-nope",
        fileId: "nonexistent-file",
        samples: [{ t: 0, x: 0, y: 0, w: 10, h: 10, confidence: 1, visible: true }],
        framerate: 30,
        method: "mediapipe-face",
      }),
    ).rejects.toThrow("file not found: nonexistent-file");
  });

  it("throws 'file must be assigned to a piece' for global files", async () => {
    await db.insert(files).values({
      id: "global-file-1",
      pieceId: null,
      filename: "g.mp4",
      name: "g",
      description: "",
      type: "video",
      storagePath: "/tmp/g.mp4",
      size: 0,
    });

    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    await expect(
      saveTrackSamples({
        trackId: "trk-global",
        fileId: "global-file-1",
        samples: [{ t: 0, x: 0, y: 0, w: 10, h: 10, confidence: 1, visible: true }],
        framerate: 30,
        method: "mediapipe-face",
      }),
    ).rejects.toThrow("file must be assigned to a piece");
  });

  it("replaces an existing track when called with the same trackId", async () => {
    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    const { getTrackRow } = await import("@/lib/tracking/repo");
    const { readTrack } = await import("@/lib/tracking/storage");

    const firstSamples = [{ t: 0, x: 5, y: 5, w: 10, h: 10, confidence: 1, visible: true }];
    await saveTrackSamples({ trackId: "trk-replace", fileId: FILE_ID, samples: firstSamples, framerate: 30, method: "mediapipe-face" });

    const secondSamples = [
      { t: 0, x: 1, y: 1, w: 2, h: 2, confidence: 0.7, visible: true },
      { t: 0.5, x: 2, y: 2, w: 3, h: 3, confidence: 0.8, visible: true },
    ];
    const result = await saveTrackSamples({ trackId: "trk-replace", fileId: FILE_ID, samples: secondSamples, framerate: 30, method: "mediapipe-face" });

    expect(result.sampleCount).toBe(2);

    // Only one DB row should exist
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getTrackRow(db as any, "trk-replace");
    expect(row).not.toBeNull();
    expect(row?.sampleCount).toBe(2);

    // Storage reflects the second write
    const track = await readTrack(PIECE_ID, "trk-replace");
    expect(track?.samples).toHaveLength(2);
    expect(track?.samples[0].x).toBe(1);
  });

  it("cleans up old JSON sidecar on cross-piece track replace", async () => {
    const PIECE_B = "piece-st-2";
    const FILE_B = "file-st-2";

    seedPiece(db, { id: PIECE_B });
    await db.insert(files).values({
      id: FILE_B,
      pieceId: PIECE_B,
      filename: "b.mp4",
      name: "b",
      description: "",
      type: "video",
      storagePath: "/tmp/b.mp4",
      size: 0,
      mediaWidth: 1280,
      mediaHeight: 720,
    });

    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    const { getTrackRow } = await import("@/lib/tracking/repo");
    const { readTrack } = await import("@/lib/tracking/storage");

    // Write initial track tied to piece-A / file-A
    await saveTrackSamples({
      trackId: "trk-cross",
      fileId: FILE_ID,
      samples: [{ t: 0, x: 1, y: 1, w: 10, h: 10, confidence: 1, visible: true }],
      framerate: 30,
      method: "mediapipe-face",
    });
    expect(await readTrack(PIECE_ID, "trk-cross")).not.toBeNull(); // sidecar on piece-A

    // Cross-piece replace: same trackId, different file on piece-B
    const result = await saveTrackSamples({
      trackId: "trk-cross",
      fileId: FILE_B,
      samples: [
        { t: 0, x: 5, y: 5, w: 20, h: 20, confidence: 0.9, visible: true },
        { t: 1, x: 6, y: 6, w: 21, h: 21, confidence: 0.8, visible: true },
      ],
      framerate: 30,
      method: "mediapipe-face",
    });

    expect(result.pieceId).toBe(PIECE_B);
    expect(result.sampleCount).toBe(2);

    // Old sidecar must be gone
    expect(await readTrack(PIECE_ID, "trk-cross")).toBeNull();
    // New sidecar must exist on piece-B
    const newTrack = await readTrack(PIECE_B, "trk-cross");
    expect(newTrack).not.toBeNull();
    expect(newTrack?.samples).toHaveLength(2);

    // Exactly one DB row, pointing to file-B
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getTrackRow(db as any, "trk-cross");
    expect(row).not.toBeNull();
    expect(row?.fileId).toBe(FILE_B);
  });

  it("handles empty samples array (durationSec = 0, sampleCount = 0)", async () => {
    const { saveTrackSamples } = await import("@/lib/tracking/save-track");
    const { getTrackRow } = await import("@/lib/tracking/repo");

    const result = await saveTrackSamples({
      trackId: "trk-empty",
      fileId: FILE_ID,
      samples: [],
      framerate: 30,
      method: "mediapipe-object",
    });

    expect(result.sampleCount).toBe(0);
    expect(result.durationSec).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getTrackRow(db as any, "trk-empty");
    expect(row?.sampleCount).toBe(0);
    expect(row?.durationSec).toBe(0);
  });
});
