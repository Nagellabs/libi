/**
 * Integration: Layer-1 concat flow via concatVideos MCP tool.
 *
 * Drives concatVideos directly against the clip-red-3s.mp4 + clip-green-3s.mp4
 * fixtures (identically encoded — same codec, size, fps, pix_fmt, audio codec,
 * audio sample rate — so the fast stream-copy path kicks in). Asserts:
 *
 * - output duration ≈ 6.0s (±0.2)
 * - both video + audio streams are preserved (h264 + aac)
 * - pixel sampling at t=0.5 is red-dominant (first half)
 * - pixel sampling at t=4.5 is green-dominant (second half) — proves ORDERING
 * - output bytes differ from both input fixtures
 *
 * Frame-time choice: t=0.5 reads from the red half (0–3s); t=4.5 reads from
 * the green half (3–6s). Avoid t=3.0 exactly — it's the seam and keyframe
 * alignment at the boundary is undefined.
 *
 * Pixel thresholds match what lavfi emits through the yuv420p round-trip:
 * red ≈ (254,0,0), ffmpeg's "green" color is mid-green ≈ (0,128,0), hence
 * G > 100 (not 150) for green-dominant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import {
  probe,
  sha256,
  extractFrameRgba,
  samplePixel,
  hasFfmpeg, FFMPEG_SKIP_REASON,
} from "@/__tests__/helpers/media";

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "helpers", "fixtures", "video");
const RED_FIXTURE = path.join(FIXTURE_DIR, "clip-red-3s.mp4");
const GREEN_FIXTURE = path.join(FIXTURE_DIR, "clip-green-3s.mp4");

const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info(`[skip] concatVideos flow — ${FFMPEG_SKIP_REASON}`);
const skipIf = ffmpegPresent ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { concatVideos } from "@/mcp/tools/ffmpeg-tools";

skipIf("Layer-1: concatVideos flow", () => {
  const PIECE_ID = "p-concat";
  const RED_ID = "f-red";
  const GREEN_ID = "f-green";
  const RED_NAME = "clip-red-3s.mp4";
  const GREEN_NAME = "clip-green-3s.mp4";

  function seedFixture(fileId: string, fixturePath: string, destName: string) {
    const pieceDir = path.join(tempDir, PIECE_ID);
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.copyFileSync(fixturePath, path.join(pieceDir, destName));
    const stat = fs.statSync(path.join(pieceDir, destName));
    testDb
      .insert(files)
      .values({
        id: fileId,
        pieceId: PIECE_ID,
        filename: destName,
        name: destName,
        description: "",
        type: "video",
        storagePath: `${PIECE_ID}/${destName}`,
        contentType: "video/mp4",
        size: stat.size,
      })
      .run();
  }

  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    seedFixture(RED_ID, RED_FIXTURE, RED_NAME);
    seedFixture(GREEN_ID, GREEN_FIXTURE, GREEN_NAME);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("joins red+green with preserved streams and correct ordering", async () => {
    const result = await concatVideos({
      pieceId: PIECE_ID,
      fileIds: [RED_ID, GREEN_ID],
    });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    const outPath = path.join(tempDir, PIECE_ID, outName);
    expect(fs.existsSync(outPath)).toBe(true);

    // Duration ≈ 6.0s (±0.2).
    const info = await probe(outPath);
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 6.0)).toBeLessThan(0.2);

    // Both streams preserved — codec h264 + aac survive stream-copy.
    expect(info.videoStream).not.toBeNull();
    expect(info.videoStream!.codec).toBe("h264");
    expect(info.videoStream!.width).toBe(320);
    expect(info.videoStream!.height).toBe(240);
    expect(info.audioStream).not.toBeNull();
    expect(info.audioStream!.codec).toBe("aac");

    // Pixel sampling at t=0.5 — red half.
    const redFrame = await extractFrameRgba(outPath, 0.5);
    const [rR, rG, rB] = samplePixel(redFrame, 160, 120);
    expect(rR).toBeGreaterThan(150);
    expect(rG).toBeLessThan(80);
    expect(rB).toBeLessThan(80);

    // Pixel sampling at t=4.5 — green half. ORDERING assertion.
    const greenFrame = await extractFrameRgba(outPath, 4.5);
    const [gR, gG, gB] = samplePixel(greenFrame, 160, 120);
    expect(gG).toBeGreaterThan(100);
    expect(gR).toBeLessThan(100);
    expect(gB).toBeLessThan(100);

    // Output bytes differ from both inputs.
    const outHash = await sha256(outPath);
    const redHash = await sha256(RED_FIXTURE);
    const greenHash = await sha256(GREEN_FIXTURE);
    expect(outHash).not.toBe(redHash);
    expect(outHash).not.toBe(greenHash);
  });
});
