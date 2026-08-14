/**
 * Integration: Layer-1 caption burn-in flow via FfmpegOverlayBackend.
 *
 * Drives the backend directly against the clip-red-3s.mp4 fixture with a
 * single text overlay painted across the top 60px band. Verifies that:
 *   - The overlay region (top band) gets brighter than the input — drawtext
 *     actually painted white glyphs on the red base.
 *   - A non-overlay region (bottom band) stays visually identical to the
 *     input — proves the overlay is spatially contained and didn't smear.
 *   - No stray libi-export-* tmp dirs remain in os.tmpdir() after run.
 *
 * Skipped when ffmpeg lacks the drawtext filter (common on homebrew builds
 * compiled without libfreetype). Thresholds are calibrated for a 48px
 * "HELLO" center-aligned across a 320×60 band on solid red — see the plan
 * doc for the brightness-delta derivation.
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
  extractFrameRgba,
  sampleRegionMean,
  listTmpExportDirs,
  hasFfmpeg,
  hasDrawtext,
} from "@/__tests__/helpers/media";

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "helpers",
  "fixtures",
  "video",
  "clip-red-3s.mp4",
);

const skipIf = hasFfmpeg() && hasDrawtext() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import type { Composition } from "@/lib/engine/types";

skipIf("Layer-1: FfmpegOverlayBackend caption burn-in", () => {
  const PIECE_ID = "p-caption";
  const FILE_ID = "f-caption";
  const SRC_NAME = "src.mp4";

  beforeEach(() => {
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

  it("burns a text overlay into the top band without touching the bottom band", async () => {
    const outPath = path.join(tempDir, "caption-out.mp4");
    const srcPath = path.join(tempDir, PIECE_ID, SRC_NAME);

    const composition: Composition = {
      id: "comp-caption",
      name: "caption",
      width: 320,
      height: 240,
      fps: 24,
      scenes: [],
      overlays: [
        {
          id: "scene-caption",
          kind: "video",
          fileId: FILE_ID,
          videoUrl: "",
          startTime: 0,
          duration: 2,
          z: 0,
          opacity: 1,
          fit: "cover",
          rect: { x: 0, y: 0, width: 320, height: 240 },
          sourceWidth: 320,
          sourceHeight: 240,
          trim: { start: 0, end: 2 },
        },
        {
          id: "t-hello",
          kind: "text",
          content: "HELLO",
          color: "#ffffff",
          font: "48px sans",
          align: "center",
          opacity: 1,
          rect: { x: 0, y: 0, width: 320, height: 60 },
          startTime: 0,
          duration: 2,
          z: 1,
        },
      ],
    };

    const backend = new FfmpegOverlayBackend();
    await backend.run({
      composition,
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      outputPath: outPath,
    });

    // File exists + duration in the expected neighborhood.
    expect(fs.existsSync(outPath)).toBe(true);
    const info = await probe(outPath);
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 2.0)).toBeLessThan(0.2);

    // Sample the overlay band (top 60px) at t=1.0 in both input and output.
    // Input time 1.0 matches output time 1.0 because the composition trim
    // is [0, 2] — no shift between input and output timelines here.
    const topRect = { x: 0, y: 0, w: 320, h: 60 };
    const bottomRect = { x: 0, y: 180, w: 320, h: 60 };

    const inFrame = await extractFrameRgba(srcPath, 1.0);
    const outFrame = await extractFrameRgba(outPath, 1.0);

    const inTop = sampleRegionMean(inFrame, topRect);
    const outTop = sampleRegionMean(outFrame, topRect);
    const inBottom = sampleRegionMean(inFrame, bottomRect);
    const outBottom = sampleRegionMean(outFrame, bottomRect);

    // Overlay region brightened meaningfully — white glyphs on red base.
    // The red fixture's sum-of-channels ≈ 254; adding white text pushes the
    // mean up by ≥60 depending on glyph coverage. See plan doc for the
    // derivation — +60 is a conservative lower bound.
    const inTopSum = inTop[0] + inTop[1] + inTop[2];
    const outTopSum = outTop[0] + outTop[1] + outTop[2];
    expect(outTopSum).toBeGreaterThan(inTopSum + 60);

    // Bottom band unchanged — per-channel delta below 10 proves the overlay
    // is spatially contained to its declared rect.
    expect(Math.abs(outBottom[0] - inBottom[0])).toBeLessThan(10);
    expect(Math.abs(outBottom[1] - inBottom[1])).toBeLessThan(10);
    expect(Math.abs(outBottom[2] - inBottom[2])).toBeLessThan(10);

    // Direct-backend path must not leak tmp dirs (API route's concern, but
    // we pin the invariant here too as a forward guard).
    const leftover = await listTmpExportDirs();
    expect(leftover).toEqual([]);
  });
});
