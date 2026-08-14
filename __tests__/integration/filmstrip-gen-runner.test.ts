/**
 * Integration: the filmstrip_gen runner against a REAL ffmpeg-generated clip.
 *
 * Mirrors the proxy-gen lifecycle: generating → ready, sprite file on disk,
 * filmstrip_* row columns populated. Generates a tiny lavfi clip into the
 * temp storage dir and drives the runner's `run()` directly with a minimal
 * JobContext (the JobManager only adds dedupe/queueing around this same call).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import {
  filmstripGenRunner,
  FILMSTRIP_FRAMES,
  FILMSTRIP_HEIGHT,
} from "@/lib/jobs/runners/filmstrip-gen";
import type { JobContext } from "@/lib/jobs/types";

const PIECE = "p1";
const FID = "f1";

function fakeCtx<P>(params: P): JobContext<P> {
  return {
    jobId: "job-test",
    params,
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
  };
}

describe("filmstrip_gen runner (real ffmpeg)", () => {
  beforeEach(() => {
    createTestDb();
    createTempStorageDir();

    getDb()
      .insert(pieces)
      .values({ id: PIECE, name: "test piece", description: "" })
      .run();

    const pieceDir = path.join(getLibiStorageDir(), PIECE);
    fs.mkdirSync(pieceDir, { recursive: true });
    const sourcePath = path.join(pieceDir, "source.mp4");
    const r = spawnSync(
      resolveFfmpegPath(),
      [
        "-y",
        "-f", "lavfi",
        "-i", "testsrc=s=320x240:d=3:r=10",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        sourcePath,
      ],
      { stdio: "ignore" },
    );
    if (r.status !== 0) throw new Error("ffmpeg failed to seed source video");

    getDb()
      .insert(files)
      .values({
        id: FID,
        pieceId: PIECE,
        filename: "source.mp4",
        name: "source.mp4",
        description: "",
        type: "video",
        storagePath: `${PIECE}/source.mp4`,
        contentType: "video/mp4",
        mediaDuration: 3,
        mediaWidth: 320,
        mediaHeight: 240,
      })
      .run();
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
  });

  it("produces the sprite file and sets filmstrip_* columns to ready", async () => {
    const result = await filmstripGenRunner.run(fakeCtx({ fileId: FID }));

    expect(result.fileId).toBe(FID);
    expect(result.filmstripFilename).toBe("source-filmstrip.jpg");
    expect(result.frames).toBe(FILMSTRIP_FRAMES);
    expect(result.height).toBe(FILMSTRIP_HEIGHT);

    // Sprite file exists on disk in the piece dir.
    const spritePath = path.join(
      getLibiStorageDir(),
      PIECE,
      "source-filmstrip.jpg",
    );
    expect(fs.existsSync(spritePath)).toBe(true);
    expect(fs.statSync(spritePath).size).toBeGreaterThan(0);

    // Row columns reflect ready state.
    const [row] = getDb().select().from(files).where(eq(files.id, FID)).all();
    expect(row.filmstripStatus).toBe("ready");
    expect(row.filmstripFilename).toBe("source-filmstrip.jpg");
    expect(row.filmstripFrames).toBe(FILMSTRIP_FRAMES);
    expect(row.filmstripHeight).toBe(FILMSTRIP_HEIGHT);
    expect(row.filmstripGeneratedAt).toBeInstanceOf(Date);
  });

  it("marks the row failed and rethrows for a non-video file", async () => {
    getDb()
      .insert(files)
      .values({
        id: "f-audio",
        pieceId: PIECE,
        filename: "a.mp3",
        name: "a.mp3",
        description: "",
        type: "audio",
        storagePath: `${PIECE}/a.mp3`,
      })
      .run();

    await expect(
      filmstripGenRunner.run(fakeCtx({ fileId: "f-audio" })),
    ).rejects.toThrow(/not a video/);
  });
});
