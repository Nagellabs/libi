import { describe, expect, it } from "vitest";
import { summarizeAnalysisBundle } from "@/lib/analysis/lean-bundle";
import type { AnalysisBundle, AnalysisKeyframe } from "@/lib/analysis/types";

function keyframe(i: number, description: string | null): AnalysisKeyframe {
  return {
    id: `kf-${i}`,
    fileId: "file-1",
    stepId: "step-1",
    filePath: `/frames/${i}.jpg`,
    frameIndex: i,
    timestamp: i * 3,
    description,
    skipped: false,
    skipReason: null,
    custom: i === 0 ? JSON.stringify({ note: "x" }) : null,
    sourceModifiedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function bundle(frameCount: number): AnalysisBundle {
  // Each description is a big structured blob — the F5 token-overflow culprit.
  // ~4 KB per frame, matching a real FrameDescription's structured weight.
  const bigDescription = JSON.stringify({
    subject: "a person demonstrating a product on camera",
    people: Array.from({ length: 4 }, (_, n) => ({
      name: `person-${n}`,
      action: "x".repeat(200),
      appearance: "y".repeat(200),
    })),
    objects: Array.from({ length: 30 }, (_, n) => ({ label: `object-${n}`, note: "z".repeat(40) })),
    tags: Array.from({ length: 40 }, (_, n) => `tag-${n}`),
  });
  return {
    steps: [],
    keyframes: Array.from({ length: frameCount }, (_, i) => keyframe(i, bigDescription)),
    audioChunks: [],
    staleKeyframeIds: [],
  };
}

describe("summarizeAnalysisBundle (F5)", () => {
  it("drops full per-frame description/custom, keeping flags + a short preview", () => {
    const lean = summarizeAnalysisBundle(bundle(3));

    expect(lean.frameDetail).toBe("summary");
    expect(lean.note).toMatch(/analysis_search_frames|frameDetail/);
    expect(lean.keyframes).toHaveLength(3);

    for (const kf of lean.keyframes) {
      // Heavy blobs are gone…
      expect("description" in kf).toBe(false);
      expect("custom" in kf).toBe(false);
      // …replaced by cheap flags + a bounded preview.
      expect(kf.hasDescription).toBe(true);
      expect(kf.descriptionPreview).not.toBeNull();
      expect((kf.descriptionPreview as string).length).toBeLessThanOrEqual(160);
      // Structural fields survive verbatim.
      expect(kf.frameIndex).toBeTypeOf("number");
      expect(kf.timestamp).toBeTypeOf("number");
    }

    expect(lean.keyframes[0].hasCustom).toBe(true);
    expect(lean.keyframes[1].hasCustom).toBe(false);
  });

  it("reports hasDescription:false + null preview for an undescribed frame", () => {
    const b = bundle(1);
    b.keyframes[0] = keyframe(0, null);
    const lean = summarizeAnalysisBundle(b);
    expect(lean.keyframes[0].hasDescription).toBe(false);
    expect(lean.keyframes[0].descriptionPreview).toBeNull();
  });

  it("shrinks the serialized payload by an order of magnitude for many frames", () => {
    const full = bundle(26);
    const lean = summarizeAnalysisBundle(full);
    const fullBytes = JSON.stringify(full).length;
    const leanBytes = JSON.stringify(lean).length;
    // The 26-frame full bundle is the dogfood overflow case; lean must be far smaller.
    expect(leanBytes).toBeLessThan(fullBytes / 5);
  });
});
