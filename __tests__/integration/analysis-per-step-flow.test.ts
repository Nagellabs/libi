import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema";
import {
  saveTranscript,
  saveSummary,
  saveFrames,
  markStepFailed,
  getAnalysis,
  removeStep,
} from "@/lib/analysis/manager";

describe("analysis per-step flow (integration)", () => {
  let fileId: string;

  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id,
      filename: "x.mp4",
      name: "x",
      description: "",
      type: "video",
      storagePath: "x.mp4",
    }).returning();
    fileId = file.id;
  });

  afterEach(() => {
    resetTestDb();
  });

  it("transcript-only flow ends in a stable state", async () => {
    // The original 'stuck' bug: transcript saved, no summary, no finalize.
    // After redesign, this is a complete end-state — no stuck status.
    await saveTranscript({ fileId, content: "hello world" });
    const result = await getAnalysis({ fileId });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("transcript");
    expect(result.steps[0].status).toBe("ready");
  });

  it("steps are independent — failed transcript doesn't block ready summary", async () => {
    await markStepFailed({ fileId, kind: "transcript", errorMessage: "no audio" });
    await saveSummary({
      fileId,
      summary: {
        schema_version: "video_v1",
        overview: "test",
        duration: 5,
        subjects: [],
        sections: [],
        recurring_objects: [],
      },
    });
    const { steps } = await getAnalysis({ fileId });
    const t = steps.find((s) => s.kind === "transcript");
    const sm = steps.find((s) => s.kind === "summary");
    expect(t?.status).toBe("failed");
    expect(t?.errorMessage).toBe("no audio");
    expect(sm?.status).toBe("ready");
  });

  it("save_frames upserts keyframes by (file_id, frame_index)", async () => {
    await saveFrames({
      fileId,
      frames: [
        { frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: '{"scene":"a"}' },
        { frameIndex: 2, timestamp: 1.0, filePath: "frame-0002.png", description: '{"scene":"b"}' },
        { frameIndex: 3, timestamp: 1.5, filePath: "frame-0003.png", skipped: true, skipReason: "blur" },
      ],
    });
    expect((await getAnalysis({ fileId })).keyframes).toHaveLength(3);

    // Upsert frame 1 only — frames 2 and 3 are preserved.
    await saveFrames({
      fileId,
      frames: [{ frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: '{"scene":"x"}' }],
    });
    const result = await getAnalysis({ fileId });
    expect(result.keyframes).toHaveLength(3);
    expect(JSON.parse(result.keyframes[0].description!).scene).toBe("x");
  });

  it("removeStep cascades to keyframes for kind=frames", async () => {
    await saveFrames({
      fileId,
      frames: [{ frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: "{}" }],
    });
    await removeStep({ fileId, kind: "frames" });
    const result = await getAnalysis({ fileId });
    expect(result.steps.find((s) => s.kind === "frames")).toBeUndefined();
    expect(result.keyframes).toHaveLength(0);
  });
});
