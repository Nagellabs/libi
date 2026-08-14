import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { saveTrackSamples } from "@/lib/tracking/save-track";
import { readTrack } from "@/lib/tracking/storage";

describe("save+read track (normalized + sanitized + summarized)", () => {
  let db: ReturnType<typeof createTestDb>;
  let tmpDir: string;

  beforeEach(async () => {
    db = createTestDb();
    tmpDir = createTempStorageDir();
    process.env.LIBI_HOME = tmpDir;
    await db.insert(pieces).values({ id: "p1", name: "P", createdAt: new Date(), updatedAt: new Date() });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    await db.insert(files).values({
      id: "f1",
      pieceId: "p1",
      filename: "v.mp4",
      name: "v",
      description: "",
      type: "video",
      storagePath: "/tmp/v.mp4",
      contentType: "video/mp4",
      size: 0,
      mediaWidth: 608,
      mediaHeight: 1080,
      mediaDuration: 38.5,
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  afterEach(() => {
    resetTestDb();
    delete process.env.LIBI_HOME;
    cleanupTempDir(tmpDir);
  });

  it("sanitizes degenerate samples, returns a summary, reads back normalized", async () => {
    const res = await saveTrackSamples({
      trackId: "trk-x", fileId: "f1", framerate: 1, method: "sam2-fal",
      samples: [
        { t: 0, x: 0, y: 0, w: 607, h: 1079, confidence: 1, visible: true },
        { t: 1, x: 5, y: 5, w: 20, h: 20, confidence: 1, visible: true },
        { t: 999, x: 5, y: 5, w: 20, h: 20, confidence: 1, visible: true },
      ],
    });
    expect(res.summary.flags).toContain("full_canvas_while_visible");
    expect(res.sampleCount).toBe(2); // t=999 dropped (> 38.5s)
    const t = await readTrack("p1", "trk-x");
    expect(t!.segments).toHaveLength(1);
    expect(t!.samples[0].visible).toBe(false); // collapse sanitized
  });
});
