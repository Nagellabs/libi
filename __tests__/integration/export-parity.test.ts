/**
 * Integration: parity — the stream-copy-trim backend produces a file whose
 * duration and codec match the requested range and source codec. Catches
 * silent regressions where a backend change alters observable output.
 *
 * Plan 3 scope: stream-copy only. Plan 4 Task 8 will extend with cross-
 * backend comparison against the ffmpeg-overlay backend.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { probeDuration, probeVideoCodec } from "@/__tests__/helpers/ffprobe";

const FIXTURE = path.resolve(__dirname, "..", "helpers", "fixtures", "tiny.mp4");
function hasFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }); return true; }
  catch { return false; }
}
const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info("[skip] export parity — ffmpeg not on PATH");
const skipIf = ffmpegPresent ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";

skipIf("export parity", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    fs.mkdirSync(path.join(tempDir, "p1"), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(tempDir, "p1", "src.mp4"));
    testDb.insert(files).values({
      id: "f1", pieceId: "p1", filename: "src.mp4", name: "s", description: "",
      type: "video", storagePath: "p1/src.mp4", contentType: "video/mp4", size: 1000,
    }).run();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("stream-copy output duration matches the requested range within 100ms", async () => {
    const outPath = path.join(tempDir, "out.mp4");
    const backend = new StreamCopyTrimBackend();
    await backend.run({
      composition: {
        id: "c", name: "", width: 320, height: 240, fps: 24,
        scenes: [],
        overlays: [{
          id: "s", kind: "video", fileId: "f1", videoUrl: "",
          startTime: 0, duration: 0.5, z: 0, opacity: 1, fit: "cover",
          rect: { x: 0, y: 0, width: 320, height: 240 },
          sourceWidth: 320, sourceHeight: 240,
          trim: { start: 0, end: 0.5 },
        }],
      },
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });
    const dur = await probeDuration(outPath);
    expect(dur).not.toBeNull();
    expect(Math.abs(dur! - 0.5)).toBeLessThan(0.1);
    const codec = await probeVideoCodec(outPath);
    expect(codec).toBe("h264"); // stream-copy preserves source codec (fixture is h264)
  });
});
