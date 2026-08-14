/**
 * Integration: Layer-1 trim flow via StreamCopyTrimBackend.
 *
 * Drives the backend directly (no API route) against the clip-red-3s.mp4
 * fixture. Asserts stream-copy preserves codecs + dimensions + audio, that
 * the output differs from the input, and that no stray tmp export dirs are
 * left in os.tmpdir() (the backend-direct path never creates libi-export-*
 * dirs — that cleanup invariant is the API route's concern, asserted here
 * as a future-proofing trailing check).
 *
 * Duration note: clip-red-3s.mp4 is libx264 ultrafast with a single keyframe
 * at t=0 (GOP ≈ 250 frames at 24fps). Stream-copy input-seek of [1, 2] still
 * yields a ~1.02s output because ffmpeg's input-seek with -ss/-to on MP4
 * resolves timestamps correctly even across non-keyframe boundaries when
 * copying; what it can't do is produce decodable frames before the first
 * keyframe — but the container duration we probe is ~1.02s regardless.
 * Tolerance: ±0.1s covers the keyframe-alignment slop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { probe, sha256, listTmpExportDirs, hasFfmpeg } from "@/__tests__/helpers/media";

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "helpers",
  "fixtures",
  "video",
  "clip-red-3s.mp4",
);

const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";

skipIf("Layer-1: StreamCopyTrimBackend trim flow", () => {
  const PIECE_ID = "p-trim";
  const FILE_ID = "f-trim";
  const SRC_NAME = "src.mp4";

  beforeEach(async () => {
    // Pre-clean any leftover libi-export-* dirs from concurrent tests so the
    // trailing invariant check at the end of each test is deterministic.
    const { listTmpExportDirs: list } = await import("@/__tests__/helpers/media");
    const leftovers = await list();
    for (const d of leftovers) {
      fs.rmSync(d, { recursive: true, force: true });
    }

    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    fs.mkdirSync(path.join(tempDir, PIECE_ID), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(tempDir, PIECE_ID, SRC_NAME));
    const stat = fs.statSync(path.join(tempDir, PIECE_ID, SRC_NAME));
    testDb
      .insert(files)
      .values({
        id: FILE_ID,
        pieceId: PIECE_ID,
        filename: SRC_NAME,
        name: SRC_NAME,
        description: "",
        type: "video",
        storagePath: `${PIECE_ID}/${SRC_NAME}`,
        contentType: "video/mp4",
        size: stat.size,
      })
      .run();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("trims [1, 2] from a 3s clip preserving codecs, dimensions, and audio", async () => {
    const outPath = path.join(tempDir, "trim-out.mp4");
    const srcPath = path.join(tempDir, PIECE_ID, SRC_NAME);
    const srcHash = await sha256(srcPath);

    const backend = new StreamCopyTrimBackend();
    const result = await backend.run({
      composition: {
        id: "comp-trim",
        name: "trim",
        width: 320,
        height: 240,
        fps: 24,
        scenes: [],
        overlays: [
          {
            id: "scene-trim",
            kind: "video",
            fileId: FILE_ID,
            videoUrl: "",
            startTime: 0,
            duration: 1,
            z: 0,
            opacity: 1,
            fit: "cover",
            rect: { x: 0, y: 0, width: 320, height: 240 },
            sourceWidth: 320,
            sourceHeight: 240,
            trim: { start: 1, end: 2 },
          },
        ],
        // In libi's audio model an inline clip is auto-created for any video
        // whose source has an audio stream, and MUTING a base removes that
        // clip. So "no clip" is now the mute signal and the backend emits
        // `-an` for it — this fixture must carry the clip to represent an
        // unmuted scene. (The muted path is asserted in
        // __tests__/integration/export-api-route.test.ts.)
        audioClips: [
          {
            id: "clip-inline-scene-trim",
            kind: "inline",
            fileId: FILE_ID,
            startTime: 0,
            duration: 1,
            trimStart: 1,
            volume: 1,
            enabled: true,
            linkedOverlayId: "scene-trim",
          },
        ],
      },
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });

    // File exists and backend-reported duration matches request.
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.duration).toBe(1);

    // Probe the output and assert codecs + dimensions + audio presence.
    const info = await probe(outPath);
    expect(info.videoStream).not.toBeNull();
    expect(info.videoStream!.codec).toBe("h264");
    expect(info.videoStream!.width).toBe(320);
    expect(info.videoStream!.height).toBe(240);

    // Audio is preserved through stream-copy.
    expect(info.audioStream).not.toBeNull();
    expect(info.audioStream!.codec).toBe("aac");
    expect(info.audioStream!.sampleRate).toBe(44100);

    // Container duration close to requested 1.0s. Tolerance ±0.1s covers
    // stream-copy keyframe-alignment slop (observed ≈1.02s on the fixture).
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 1.0)).toBeLessThan(0.1);

    // Output is a distinct file from the source.
    const outHash = await sha256(outPath);
    expect(outHash).not.toBe(srcHash);

    // Trailing invariant: the direct-backend path should not leave stray
    // libi-export-* dirs in os.tmpdir(). Regression guard in case the
    // backend ever starts using os.tmpdir() directly.
    const leftover = await listTmpExportDirs();
    expect(leftover).toEqual([]);
  });
});
