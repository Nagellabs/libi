import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

const FIXTURE = path.resolve(__dirname, "..", "helpers", "fixtures", "tiny.mp4");
function hasFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }); return true; }
  catch { return false; }
}
const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info("[skip] StreamCopyTrimBackend — ffmpeg not on PATH");
const skipIf = ffmpegPresent ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";

skipIf("StreamCopyTrimBackend", () => {
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

  it("trims a clip to the requested duration", async () => {
    const outPath = path.join(tempDir, "out.mp4");
    const backend = new StreamCopyTrimBackend();
    const result = await backend.run({
      composition: {
        id: "c", name: "", width: 320, height: 240, fps: 24,
        scenes: [],
        overlays: [{
          id: "s1", kind: "video", fileId: "f1", videoUrl: "",
          startTime: 0, duration: 0.5, z: 0, opacity: 1, fit: "cover",
          rect: { x: 0, y: 0, width: 320, height: 240 },
          sourceWidth: 320, sourceHeight: 240,
          trim: { start: 0, end: 0.5 },
        }],
      },
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.duration).toBe(0.5);

    // ffprobe duration check
    const probe = execFileSync("ffprobe", [
      "-v", "quiet", "-print_format", "json",
      "-show_format", outPath,
    ]).toString();
    const { format } = JSON.parse(probe);
    const actualDur = parseFloat(format.duration);
    expect(Math.abs(actualDur - 0.5)).toBeLessThan(0.1); // within 100ms tolerance
  });
});
