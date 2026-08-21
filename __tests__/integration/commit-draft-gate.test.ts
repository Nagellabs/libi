import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files, analysisSteps, analysisKeyframes } from "@/lib/db/schema/sqlite";
import { saveManifest } from "@/lib/composition/persistence";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { commitDraftTool } from "@/mcp/tools/snapshot-tools";

const PIECE = "commit-gate-piece";

function videoManifest(fileId: string): CompositionManifest {
  return {
    width: 1080, height: 1920, fps: 30, 
    overlays: [{
      id: "ov1", kind: "video", fileId, displayName: "v",
      startTime: 0, duration: 8, z: 0, opacity: 1, fit: "cover",
      rect: { x: 0, y: 0, width: 1080, height: 1920 },
    }],
  };
}

function insertAiVideo(db: ReturnType<typeof createTestDb>, id: string) {
  db.insert(files).values({
    id, pieceId: PIECE, filename: `${id}.mp4`, name: id, description: "", type: "video",
    storagePath: `${PIECE}/${id}.mp4`, contentType: "video/mp4", aiGeneration: '{"provider":"fal-ai"}',
  }).run();
}

function insertCompletedAnalysis(db: ReturnType<typeof createTestDb>, fileId: string) {
  db.insert(analysisSteps).values({ id: `step-${fileId}`, fileId, pieceId: PIECE, kind: "summary", status: "ready", content: "{}" }).run();
  db.insert(analysisKeyframes).values({
    id: `kf-${fileId}`, fileId, stepId: `step-${fileId}`, filePath: "f.png", frameIndex: 1, timestamp: 1, description: "{}", skipped: false,
  }).run();
}

describe("commit_draft verify-gate", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("blocks commit when an AI clip on the timeline is unvalidated", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertAiVideo(db, "vid-1");
    await saveManifest(PIECE, videoManifest("vid-1"));

    const res = await commitDraftTool({ pieceId: PIECE });
    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected failure");
    expect(res.error).toBe("unvalidated_generated_clips");
    expect((res.data as { unvalidatedClips: { fileId: string }[] }).unvalidatedClips.map((c) => c.fileId)).toEqual(["vid-1"]);
  });

  it("allows commit when the AI clip has a completed analysis", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertAiVideo(db, "vid-1");
    insertCompletedAnalysis(db, "vid-1");
    await saveManifest(PIECE, videoManifest("vid-1"));

    const res = await commitDraftTool({ pieceId: PIECE });
    expect(res.success).toBe(true);
  });

  it("allows commit of an unvalidated clip when acknowledgeUnvalidated is true", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertAiVideo(db, "vid-1");
    await saveManifest(PIECE, videoManifest("vid-1"));

    const res = await commitDraftTool({ pieceId: PIECE, acknowledgeUnvalidated: true });
    expect(res.success).toBe(true);
  });
});
