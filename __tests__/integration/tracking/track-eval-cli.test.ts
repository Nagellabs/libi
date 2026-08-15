import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { saveTrackSamples } from "@/lib/tracking/save-track";
import { runTrackEval } from "@/scripts/track-eval/index";
import { SYNTHETIC_VIDEO_FIXTURE } from "./fixture-guard";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// Resolves a saved `manual` track and renders it — the file only has to be a
// decodable video, so this uses the committed synthetic clip rather than the
// uncommitted face footage, and runs everywhere.
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("runTrackEval", () => {
  let out = "";
  beforeEach(async () => {
    createTestDb();
    await createTempStorageDir();
  });
  afterEach(async () => { resetTestDb(); cleanupTempDir(); if (out) await rm(out, { recursive: true, force: true }); });

  it("resolves a real saved track and writes annotated mp4 + metrics json", async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    await db.insert(pieces).values({ id: "p1", name: "P", createdAt: new Date(), updatedAt: new Date() });
    const { cpSync, mkdirSync } = await import("node:fs");
    const { getLibiStorageDir } = await import("@/lib/libi-home");
    mkdirSync(join(getLibiStorageDir(), "p1"), { recursive: true });
    cpSync(SYNTHETIC_VIDEO_FIXTURE, join(getLibiStorageDir(), "p1", "v.mp4"));
    // Dimensions and duration must match the fixture actually copied above —
    // the clip is 320×240 / 3s (see __tests__/helpers/fixtures/video/).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(files).values({ id: "f1", pieceId: "p1", filename: "v.mp4", name: "v", description: "", type: "video", storagePath: "", contentType: "video/mp4", createdAt: new Date(), mediaWidth: 320, mediaHeight: 240, mediaDuration: 3 } as any);
    await saveTrackSamples({
      trackId: "trk-1", fileId: "f1", framerate: 5, method: "manual",
      samples: Array.from({ length: 6 }, (_, i) => ({ t: i / 5, x: 40, y: 40, w: 80, h: 80, confidence: 1, visible: true })),
    });

    out = await mkdtemp(join(tmpdir(), "te-cli-"));
    const res = await runTrackEval({ fileId: "f1", trackId: "trk-1", outDir: out });
    const metrics = JSON.parse(await readFile(res.metricsPath, "utf8"));
    expect(metrics.total).toBe(6);
    expect(metrics.visible).toBe(6);
    expect(res.videoPath).toMatch(/\.mp4$/);
  }, 60_000);
});
