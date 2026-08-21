/**
 * Integration: FfmpegOverlayBackend renders a video scene + a text overlay
 * end-to-end. Skipped if ffmpeg/ffprobe aren't on PATH.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { probeDuration } from "@/__tests__/helpers/ffprobe";
import {
  hasFfmpeg,
  hasDrawtext,
  FFMPEG_SKIP_REASON,
  DRAWTEXT_SKIP_REASON,
} from "@/__tests__/helpers/media";

const FIXTURE = path.resolve(__dirname, "..", "helpers", "fixtures", "tiny.mp4");
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext())
  console.info(`[skip] text-overlay render — ${DRAWTEXT_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;
const skipIfNoDrawtext = hasDrawtext() ? it : it.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import type { Composition } from "@/lib/engine/types";

skipIf("FfmpegOverlayBackend", () => {
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

  skipIfNoDrawtext("renders a video + text overlay", async () => {
    const outPath = path.join(tempDir, "out.mp4");
    const backend = new FfmpegOverlayBackend();
    const composition: Composition = {
      id: "c", name: "", width: 320, height: 240, fps: 24,
      overlays: [{
        id: "s1", kind: "video", fileId: "f1", videoUrl: "",
        startTime: 0, duration: 0.5, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 320, height: 240 },
        sourceWidth: 320, sourceHeight: 240,
        trim: { start: 0, end: 0.5 },
      }, {
        id: "t1", kind: "text", content: "Hello",
        font: "24px sans", color: "#ffffff", align: "center", opacity: 1,
        rect: { x: 0, y: 0, width: 320, height: 40 },
        startTime: 0, duration: 0.5, z: 1,
      }],
    };

    const result = await backend.run({
      composition,
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);

    const dur = await probeDuration(outPath);
    expect(dur).not.toBeNull();
    expect(Math.abs(dur! - 0.5)).toBeLessThan(0.2); // re-encoded; slightly looser tolerance than stream-copy
  });

  it("renders a video with no overlays (defensive — shouldn't occur for this shape)", async () => {
    const outPath = path.join(tempDir, "out.mp4");
    const backend = new FfmpegOverlayBackend();
    const composition: Composition = {
      id: "c", name: "", width: 320, height: 240, fps: 24,
      overlays: [{
        id: "s1", kind: "video", fileId: "f1", videoUrl: "",
        startTime: 0, duration: 0.5, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 320, height: 240 },
        sourceWidth: 320, sourceHeight: 240,
        trim: { start: 0, end: 0.5 },
      }],
    };
    const result = await backend.run({
      composition,
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);
  });
});
