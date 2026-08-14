import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { deriveAnchors, mergeAnchors } from "@/lib/analysis/manager";
import { getDb } from "@/lib/db/client";
import { files, pieces, analysisSteps, analysisKeyframes } from "@/lib/db/schema";
import type { Anchor } from "@/lib/tracking/types";

const MEDIA_WIDTH = 1920;
const MEDIA_HEIGHT = 1080;

async function seedFileAndStep() {
  const db = getDb();
  const [piece] = await db
    .insert(pieces)
    .values({ name: "test", description: "" })
    .returning();
  const [file] = await db
    .insert(files)
    .values({
      pieceId: piece.id,
      filename: "v.mp4",
      name: "v",
      description: "",
      type: "video",
      storagePath: "v.mp4",
      mediaWidth: MEDIA_WIDTH,
      mediaHeight: MEDIA_HEIGHT,
    })
    .returning();
  const [step] = await db
    .insert(analysisSteps)
    .values({ fileId: file.id, pieceId: piece.id, kind: "frames", status: "ready" })
    .returning();
  return { pieceId: piece.id, fileId: file.id, stepId: step.id };
}

async function insertKeyframe(
  fileId: string,
  stepId: string,
  opts: {
    frameIndex: number;
    timestamp: number;
    description?: object;
  },
) {
  const db = getDb();
  await db.insert(analysisKeyframes).values({
    fileId,
    stepId,
    filePath: `frame-${String(opts.frameIndex).padStart(4, "0")}.png`,
    frameIndex: opts.frameIndex,
    timestamp: opts.timestamp,
    description: opts.description ? JSON.stringify(opts.description) : null,
  });
}

describe("deriveAnchors", () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    resetTestDb();
  });

  it("returns empty result when file has no keyframes", async () => {
    const { fileId } = await seedFileAndStep();
    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(0);
    expect(result.rejectedCount).toBe(0);
  });

  it("returns empty result when no keyframe has matching name", async () => {
    const { fileId, stepId } = await seedFileAndStep();
    await insertKeyframe(fileId, stepId, {
      frameIndex: 1,
      timestamp: 2,
      description: {
        schema_version: "frame_v1",
        frame_index: 1,
        timestamp: 2,
        scene: "test",
        setting: { location: "indoor" },
        people: [{ name: "Bob", description: "man", bbox: [0.1, 0.1, 0.2, 0.5] }],
        objects: [],
      },
    });
    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(0);
    expect(result.rejectedCount).toBe(0);
  });

  it("extracts anchors from 5 of 7 keyframes when others lack bbox", async () => {
    const { fileId, stepId } = await seedFileAndStep();
    const bboxFrames = [1, 3, 5, 6, 7];
    const noBboxFrames = [2, 4];

    for (const idx of bboxFrames) {
      await insertKeyframe(fileId, stepId, {
        frameIndex: idx,
        timestamp: idx * 5,
        description: {
          schema_version: "frame_v1",
          frame_index: idx,
          timestamp: idx * 5,
          scene: "test",
          setting: { location: "studio" },
          people: [{ name: "Lisa", description: "woman", bbox: [0.35, 0.1, 0.3, 0.8] }],
          objects: [],
        },
      });
    }
    for (const idx of noBboxFrames) {
      await insertKeyframe(fileId, stepId, {
        frameIndex: idx,
        timestamp: idx * 5,
        description: {
          schema_version: "frame_v1",
          frame_index: idx,
          timestamp: idx * 5,
          scene: "test",
          setting: { location: "studio" },
          people: [{ name: "Lisa", description: "woman" }],
          objects: [],
        },
      });
    }

    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(5);
    expect(result.rejectedCount).toBe(0);

    // Verify pixel conversion on the first anchor (bbox [0.35, 0.1, 0.3, 0.8], timestamp 5)
    const first = result.anchors[0];
    expect(first.time).toBe(5);
    expect(first.bbox[0]).toBeCloseTo(0.35 * MEDIA_WIDTH);
    expect(first.bbox[1]).toBeCloseTo(0.1 * MEDIA_HEIGHT);
    expect(first.bbox[2]).toBeCloseTo(0.3 * MEDIA_WIDTH);
    expect(first.bbox[3]).toBeCloseTo(0.8 * MEDIA_HEIGHT);
  });

  it("matches subject name case-insensitively", async () => {
    const { fileId, stepId } = await seedFileAndStep();
    await insertKeyframe(fileId, stepId, {
      frameIndex: 1,
      timestamp: 3,
      description: {
        schema_version: "frame_v1",
        frame_index: 1,
        timestamp: 3,
        scene: "test",
        setting: { location: "outdoor" },
        people: [{ name: "lisa", description: "woman", bbox: [0.2, 0.1, 0.3, 0.7] }],
        objects: [],
      },
    });
    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(1);
  });

  it("drops invalid bboxes — negative, out-of-range, zero-size, NaN", async () => {
    const { fileId, stepId } = await seedFileAndStep();

    const badBboxes = [
      [-0.1, 0.1, 0.3, 0.5],   // negative x
      [0.1, -0.1, 0.3, 0.5],   // negative y
      [0.8, 0.1, 0.3, 0.5],    // x + w > 1 (0.8 + 0.3 = 1.1)
      [0.1, 0.1, 0.005, 0.5],  // w too small
      [0.1, 0.1, 0.3, 0.005],  // h too small
      [NaN, 0.1, 0.3, 0.5],    // NaN
    ];

    for (const [i, bbox] of badBboxes.entries()) {
      await insertKeyframe(fileId, stepId, {
        frameIndex: i + 1,
        timestamp: (i + 1) * 2,
        description: {
          schema_version: "frame_v1",
          frame_index: i + 1,
          timestamp: (i + 1) * 2,
          scene: "test",
          setting: { location: "indoor" },
          people: [{ name: "Lisa", description: "woman", bbox }],
          objects: [],
        },
      });
    }

    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(0);
    expect(result.rejectedCount).toBe(badBboxes.length);
  });

  it("applies aspect ratio check for people (person bbox w/h = 0.84/0.04 = 21 > 20.0 upper bound is dropped)", async () => {
    const { fileId, stepId } = await seedFileAndStep();

    // bbox [0.05, 0.05, 0.84, 0.04]: w=0.84>0.01, h=0.04>0.01 (passes dimension guard),
    // x+w=0.89≤1.001, y+h=0.09≤1.001 (passes bounds guard),
    // aspect=0.84/0.04=21.0 > 20.0 → rejected specifically by the aspect upper bound.
    await insertKeyframe(fileId, stepId, {
      frameIndex: 1,
      timestamp: 1,
      description: {
        schema_version: "frame_v1",
        frame_index: 1,
        timestamp: 1,
        scene: "test",
        setting: { location: "outdoor" },
        people: [{ name: "Lisa", description: "woman", bbox: [0.05, 0.05, 0.84, 0.04] }],
        objects: [],
      },
    });

    const result = await deriveAnchors({ fileId, subjectName: "Lisa" });
    expect(result.anchors).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("does NOT apply aspect ratio check for items (license-plate-shaped bbox passes)", async () => {
    const { fileId, stepId } = await seedFileAndStep();

    // Wide bbox — w/h = 0.4/0.02 = 20, which would fail for a person
    await insertKeyframe(fileId, stepId, {
      frameIndex: 1,
      timestamp: 1,
      description: {
        schema_version: "frame_v1",
        frame_index: 1,
        timestamp: 1,
        scene: "test",
        setting: { location: "outdoor" },
        people: [],
        objects: [{ name: "license-plate", description: "plate", bbox: [0.1, 0.1, 0.4, 0.02] }],
      },
    });

    const result = await deriveAnchors({ fileId, itemName: "license-plate" });
    expect(result.anchors).toHaveLength(1);
    expect(result.rejectedCount).toBe(0);
  });

  it("throws a clear error when mediaWidth or mediaHeight is missing", async () => {
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db
      .insert(files)
      .values({
        pieceId: piece.id,
        filename: "v.mp4",
        name: "v",
        description: "",
        type: "video",
        storagePath: "v.mp4",
        // mediaWidth and mediaHeight intentionally not set
      })
      .returning();

    await expect(deriveAnchors({ fileId: file.id, subjectName: "Lisa" })).rejects.toThrow(
      /missing mediaWidth\/mediaHeight/,
    );
  });

  it("returns empty for file not found", async () => {
    await expect(deriveAnchors({ fileId: "nonexistent", subjectName: "Lisa" })).rejects.toThrow(
      /file not found/,
    );
  });

  it("derives item anchors using itemName", async () => {
    const { fileId, stepId } = await seedFileAndStep();
    await insertKeyframe(fileId, stepId, {
      frameIndex: 1,
      timestamp: 10,
      description: {
        schema_version: "frame_v1",
        frame_index: 1,
        timestamp: 10,
        scene: "product shot",
        setting: { location: "studio" },
        people: [],
        objects: [{ name: "red-logo", description: "logo", bbox: [0.4, 0.4, 0.2, 0.2] }],
      },
    });

    const result = await deriveAnchors({ fileId, itemName: "red-logo" });
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0].time).toBe(10);
    expect(result.anchors[0].bbox[0]).toBeCloseTo(0.4 * MEDIA_WIDTH);
  });
});

describe("mergeAnchors", () => {
  const makeAnchor = (time: number): Anchor => ({
    fileId: "f",
    time,
    bbox: [0, 0, 10, 10],
  });

  it("no manual + N derived → N merged", () => {
    const derived = [1, 2, 3].map(makeAnchor);
    expect(mergeAnchors([], derived)).toHaveLength(3);
  });

  it("manual + no derived → manual only", () => {
    const manual = [5, 10].map(makeAnchor);
    expect(mergeAnchors(manual, [])).toHaveLength(2);
  });

  it("collision: manual at t=10 and derived at t=10.05 — derived dropped", () => {
    const manual = [makeAnchor(10)];
    const derived = [makeAnchor(10.05)];
    const merged = mergeAnchors(manual, derived);
    expect(merged).toHaveLength(1);
    expect(merged[0].time).toBe(10);
  });

  it("collision at epsilon boundary: derived at t+0.1 is dropped (IEEE 754: 5.1-5.0 < 0.1)", () => {
    // 5.1 - 5.0 evaluates to ~0.09999999999999964 due to IEEE 754, which is
    // < MERGE_EPSILON_S (0.1), so this counts as a collision and the derived
    // anchor is dropped.
    const manual = [makeAnchor(5.0)];
    const derived = [makeAnchor(5.1)];
    const merged = mergeAnchors(manual, derived);
    expect(merged).toHaveLength(1);
    expect(merged[0].time).toBe(5.0);
  });

  it("no collision at t+0.11 — both kept", () => {
    const manual = [makeAnchor(5)];
    const derived = [makeAnchor(5.11)];
    const merged = mergeAnchors(manual, derived);
    expect(merged).toHaveLength(2);
  });

  it("output is sorted by time", () => {
    const manual = [makeAnchor(20), makeAnchor(5)];
    const derived = [makeAnchor(10), makeAnchor(1)];
    const merged = mergeAnchors(manual, derived);
    const times = merged.map((a) => a.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
