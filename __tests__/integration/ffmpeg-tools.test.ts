/**
 * Integration: libi.trim_video / extract_audio / generate_thumbnails / concat_videos
 *
 * Runs the real ffmpeg binary against the tiny.mp4 fixture. Skipped when ffmpeg
 * is unavailable so local devs and CI without binaries don't hard-fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

const FIXTURE = path.resolve(__dirname, "..", "helpers", "fixtures", "tiny.mp4");

function hasFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
const skipAll = !hasFfmpeg();
if (skipAll) console.info("[skip] ffmpeg MCP tools — ffmpeg not on PATH");
const skipIf = skipAll ? describe.skip : describe;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import {
  trimVideo,
  extractAudio,
  generateThumbnails,
  concatVideos,
} from "@/mcp/tools/ffmpeg-tools";

const PIECE_ID = "piece-ff";

async function seedSourceFile(name: string): Promise<string> {
  const fileId = `file-${name.replace(/\./g, "-")}`;
  const pieceDir = path.join(tempDir, PIECE_ID);
  fs.mkdirSync(pieceDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(pieceDir, name));
  const stat = fs.statSync(path.join(pieceDir, name));
  testDb
    .insert(files)
    .values({
      id: fileId,
      pieceId: PIECE_ID,
      filename: name,
      name,
      description: "",
      type: "video",
      storagePath: `${PIECE_ID}/${name}`,
      contentType: "video/mp4",
      size: stat.size,
    })
    .run();
  return fileId;
}

skipIf("ffmpeg MCP tools", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "FF Piece" });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("trimVideo produces a shorter clip", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await trimVideo({
      pieceId: PIECE_ID,
      fileId,
      startSeconds: 0,
      endSeconds: 0.5,
    });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    const outPath = path.join(tempDir, PIECE_ID, outName);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(0);
  });

  it("extractAudio defaults to a fal-safe .mp3 (so a plain call is a usable @Audio1 reference)", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await extractAudio({ pieceId: PIECE_ID, fileId });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    // Default must NOT be .m4a/AAC — that 422s on Seedance audio_urls.
    expect(outName.endsWith(".mp3")).toBe(true);
    const outPath = path.join(tempDir, PIECE_ID, outName);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("extractAudio format='copy' stream-copies to .m4a (explicit opt-out of transcode)", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await extractAudio({ pieceId: PIECE_ID, fileId, format: "copy" });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    expect(outName.endsWith(".m4a")).toBe(true);
    expect(fs.existsSync(path.join(tempDir, PIECE_ID, outName))).toBe(true);
  });

  it("extractAudio format='wav' transcodes to a .wav file (Seedance @Audio1-acceptable)", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await extractAudio({ pieceId: PIECE_ID, fileId, format: "wav" });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    expect(outName.endsWith(".wav")).toBe(true);
    const outPath = path.join(tempDir, PIECE_ID, outName);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(0);
  });

  it("extractAudio with a [start,end) range yields a shorter clip than the full track", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const full = await extractAudio({ pieceId: PIECE_ID, fileId, format: "wav" });
    const fullDur = (full.data as { durationSeconds: number | null }).durationSeconds ?? 0;
    expect(fullDur).toBeGreaterThan(0.3);

    const clip = await extractAudio({
      pieceId: PIECE_ID,
      fileId,
      format: "wav",
      startSeconds: 0,
      endSeconds: 0.3,
      outputName: "sample-0-0.3.wav",
    });
    expect(clip.success).toBe(true);
    const clipDur = (clip.data as { durationSeconds: number | null }).durationSeconds ?? 0;
    expect(clipDur).toBeGreaterThan(0);
    expect(clipDur).toBeLessThan(fullDur);
  });

  it("extractAudio rejects endSeconds without startSeconds", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await extractAudio({ pieceId: PIECE_ID, fileId, endSeconds: 5 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/startSeconds/);
  });

  it("extractAudio rejects an inverted range", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await extractAudio({
      pieceId: PIECE_ID,
      fileId,
      startSeconds: 2,
      endSeconds: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/greater than startSeconds/);
  });

  it("generateThumbnails writes N jpeg files", async () => {
    const fileId = await seedSourceFile("src.mp4");
    const result = await generateThumbnails({
      pieceId: PIECE_ID,
      fileId,
      count: 3,
    });
    expect(result.success).toBe(true);
    const { filenames } = result.data as { filenames: string[] };
    expect(filenames).toHaveLength(3);
    for (const name of filenames) {
      const p = path.join(tempDir, PIECE_ID, name);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }
  });

  it("concatVideos joins two copies of the fixture", async () => {
    const fileId1 = await seedSourceFile("a.mp4");
    const fileId2 = await seedSourceFile("b.mp4");
    const result = await concatVideos({
      pieceId: PIECE_ID,
      fileIds: [fileId1, fileId2],
    });
    expect(result.success).toBe(true);
    const outName = (result.data as { filename: string }).filename;
    const outPath = path.join(tempDir, PIECE_ID, outName);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(0);
  });
});
