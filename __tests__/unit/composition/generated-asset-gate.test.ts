import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { pieces, files, analysisSteps, analysisKeyframes } from "@/lib/db/schema/sqlite";
import { saveManifest } from "@/lib/composition/persistence";
import type { CompositionManifest } from "@/lib/composition/persistence";
import {
  collectTimelineVideoFileIds,
  isAiGeneratedFile,
  hasBaseAnalysis,
  findUnvalidatedGeneratedClips,
} from "@/lib/composition/generated-asset-gate";

const PIECE = "gate-piece";

function manifestWith(overlays?: CompositionManifest["overlays"]): CompositionManifest {
  return { width: 1080, height: 1920, fps: 30, overlays };
}

/** Full-frame base video overlay carrying `fileId` — the modern spelling of
 *  "this clip is on the timeline". */
function videoOverlay(id: string, fileId: string, z = 0): NonNullable<CompositionManifest["overlays"]>[number] {
  return {
    id, kind: "video", fileId,
    startTime: 0, duration: 8, z, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 1080, height: 1920 },
  };
}

function insertFile(db: ReturnType<typeof createTestDb>, id: string, opts: { aiGeneration?: string | null; notes?: string | null } = {}) {
  db.insert(files).values({
    id,
    pieceId: PIECE,
    filename: `${id}.mp4`,
    name: id,
    description: "",
    type: "video",
    storagePath: `${PIECE}/${id}.mp4`,
    contentType: "video/mp4",
    aiGeneration: opts.aiGeneration ?? null,
    notes: opts.notes ?? null,
  }).run();
}

function insertCompletedAnalysis(db: ReturnType<typeof createTestDb>, fileId: string) {
  db.insert(analysisSteps).values({
    id: `step-sum-${fileId}`, fileId, pieceId: PIECE, kind: "summary", status: "ready", content: "{}",
  }).run();
  db.insert(analysisKeyframes).values({
    id: `kf-${fileId}`, fileId, stepId: `step-sum-${fileId}`, filePath: "frame-0001.png",
    frameIndex: 1, timestamp: 1.0, description: "{\"shot\":\"close-up\"}", skipped: false,
  }).run();
}

describe("collectTimelineVideoFileIds", () => {
  it("collects video overlay fileIds, ignores code / image overlays", () => {
    const m = manifestWith(
      [
        { id: "bg1", kind: "code" as const, startTime: 0, duration: 2, z: -1, opacity: 1, rect: { x: 0, y: 0, width: 1080, height: 1920 }, drawFunction: "" },
        videoOverlay("o0", "vid-1"),
        { id: "o1", kind: "video", startTime: 0, duration: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 1, opacity: 1, fileId: "vid-2" },
        { id: "o2", kind: "image", startTime: 0, duration: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 2, opacity: 1, fileId: "img-1" },
      ],
    );
    expect(collectTimelineVideoFileIds(m).sort()).toEqual(["vid-1", "vid-2"]);
  });

  it("returns empty for a code-only timeline", () => {
    const m = manifestWith([{ id: "bg1", kind: "code" as const, startTime: 0, duration: 2, z: -1, opacity: 1, rect: { x: 0, y: 0, width: 1080, height: 1920 }, drawFunction: "" }]);
    expect(collectTimelineVideoFileIds(m)).toEqual([]);
  });
});

describe("isAiGeneratedFile", () => {
  it("true when ai_generation column is set", () => {
    expect(isAiGeneratedFile({ aiGeneration: '{"provider":"fal-ai"}', notes: null })).toBe(true);
  });
  it("true when notes carry a lineage line with model=", () => {
    expect(isAiGeneratedFile({ aiGeneration: null, notes: "2026-05-28T00:00:00Z | model=fal-ai/veo3.1/fast | retry=0" })).toBe(true);
  });
  it("false for a plain upload", () => {
    expect(isAiGeneratedFile({ aiGeneration: null, notes: "user note about the clip" })).toBe(false);
  });
});

describe("hasBaseAnalysis", () => {
  it("true with a ready summary + one described frame", () => {
    expect(hasBaseAnalysis({ steps: [{ kind: "summary", status: "ready" }], keyframes: [{ skipped: false, description: "{}" }] })).toBe(true);
  });
  it("false with frames but no ready summary", () => {
    expect(hasBaseAnalysis({ steps: [{ kind: "frames", status: "ready" }], keyframes: [{ skipped: false, description: "{}" }] })).toBe(false);
  });
  it("false when the only frame is skipped", () => {
    expect(hasBaseAnalysis({ steps: [{ kind: "summary", status: "ready" }], keyframes: [{ skipped: true, description: null }] })).toBe(false);
  });
});

describe("findUnvalidatedGeneratedClips", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("flags an AI video clip on the timeline with no analysis", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertFile(db, "vid-1", { aiGeneration: '{"provider":"fal-ai"}' });
    await saveManifest(PIECE, manifestWith([videoOverlay("o1", "vid-1")]));

    const out = await findUnvalidatedGeneratedClips(PIECE);
    expect(out.map((c) => c.fileId)).toEqual(["vid-1"]);
  });

  it("passes an AI video clip that has a completed analysis", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertFile(db, "vid-1", { aiGeneration: '{"provider":"fal-ai"}' });
    insertCompletedAnalysis(db, "vid-1");
    await saveManifest(PIECE, manifestWith([videoOverlay("o1", "vid-1")]));

    expect(await findUnvalidatedGeneratedClips(PIECE)).toEqual([]);
  });

  it("ignores a non-AI (plain upload) video clip", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    insertFile(db, "vid-1", {});
    await saveManifest(PIECE, manifestWith([videoOverlay("o1", "vid-1")]));

    expect(await findUnvalidatedGeneratedClips(PIECE)).toEqual([]);
  });

  it("returns empty for an empty/code-only timeline", async () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: PIECE, name: "p" }).run();
    await saveManifest(PIECE, manifestWith([{ id: "bg1", kind: "code" as const, startTime: 0, duration: 2, z: -1, opacity: 1, rect: { x: 0, y: 0, width: 1080, height: 1920 }, drawFunction: "" }]));

    expect(await findUnvalidatedGeneratedClips(PIECE)).toEqual([]);
  });
});
