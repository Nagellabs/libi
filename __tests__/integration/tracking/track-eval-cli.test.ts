import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { saveTrackSamples } from "@/lib/tracking/save-track";
import { runTrackEval } from "@/scripts/track-eval/index";
import { hasFaceFixture, FIXTURE_SKIP_REASON } from "./fixture-guard";

if (!hasFaceFixture) console.info(`[skip] ${FIXTURE_SKIP_REASON}`);

describe.skipIf(!hasFaceFixture)("runTrackEval", () => {
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
    cpSync("__tests__/fixtures/tracking/non-selfie-face-5s.mp4", join(getLibiStorageDir(), "p1", "v.mp4"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(files).values({ id: "f1", pieceId: "p1", filename: "v.mp4", name: "v", description: "", type: "video", storagePath: "", contentType: "video/mp4", createdAt: new Date(), mediaWidth: 1280, mediaHeight: 720, mediaDuration: 5 } as any);
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
