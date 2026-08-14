import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import { trimVideo } from "@/mcp/tools/ffmpeg-tools";
import { files, pieces } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { getLibiStorageDir } from "@/lib/libi-home";

/**
 * Phase 4 blocker #34: libi.trim_video must probe + persist mediaDuration /
 * mediaWidth / mediaHeight on the new files row so libi.add_overlay
 * doesn't reject it with "has no duration metadata - re-upload the file".
 */
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("trimVideo persists media metadata on the output file row", () => {
  const pieceId = "p1";
  const sourceFileId = "src-1";

  beforeEach(() => {
    createTestDb();
    createTempStorageDir();

    // Seed piece row.
    getDb()
      .insert(pieces)
      .values({ id: pieceId, name: "test piece", description: "" })
      .run();

    // Generate a 4-second source video at 320x240 using ffmpeg lavfi, writing
    // to where LocalFileStorage will look it up.
    const storageDir = getLibiStorageDir();
    const pieceDir = path.join(storageDir, pieceId);
    fs.mkdirSync(pieceDir, { recursive: true });
    const sourcePath = path.join(pieceDir, "source.mp4");
    const r = spawnSync(
      resolveFfmpegPath(),
      [
        "-y",
        "-f", "lavfi",
        "-i", "color=c=red:s=320x240:d=4",
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
        id: sourceFileId,
        pieceId,
        filename: "source.mp4",
        name: "source.mp4",
        description: "",
        type: "video",
        storagePath: `${pieceId}/source.mp4`,
        contentType: "video/mp4",
        mediaDuration: 4,
        mediaWidth: 320,
        mediaHeight: 240,
      })
      .run();
  });

  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
  });

  it("writes mediaDuration / mediaWidth / mediaHeight on the trimmed output", async () => {
    const result = await trimVideo({
      pieceId,
      fileId: sourceFileId,
      startSeconds: 0,
      endSeconds: 2,
      outputName: "trim.mp4",
    });

    expect(result.success).toBe(true);
    const newId = (result as { success: true; data: { fileId: string } }).data.fileId;
    expect(newId).toBeTruthy();

    const [row] = getDb()
      .select()
      .from(files)
      .where(eq(files.id, newId))
      .limit(1)
      .all();

    expect(row).toBeDefined();
    expect(row.mediaDuration).toBeTypeOf("number");
    expect(row.mediaDuration!).toBeGreaterThan(1.5);
    expect(row.mediaDuration!).toBeLessThan(2.5);
    expect(row.mediaWidth).toBe(320);
    expect(row.mediaHeight).toBe(240);
  });
});
