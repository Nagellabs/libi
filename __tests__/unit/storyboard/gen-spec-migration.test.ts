import { describe, it, expect } from "vitest";
import { migrateCardGeneration } from "@/lib/storyboard/repo";
import { parseCard } from "@/lib/storyboard/zod";
import type { StoryboardCard } from "@/lib/storyboard/types";

const base: StoryboardCard = {
  id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video",
  title: "t",
  sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } }],
  camera: { shot: "medium" }, promptFragment: "p",
  stage: "clip", approvals: {},
};

describe("migrateCardGeneration", () => {
  it("lifts clipFileId into a v1 take selected on the timeline", () => {
    const out = migrateCardGeneration({ ...base, clipFileId: "file_clip" });
    expect(out.clips).toEqual([
      { id: expect.any(String), fileId: "file_clip", label: "v1", createdAt: expect.any(Number) },
    ]);
    expect(out.selectedClipId).toBe(out.clips![0].id);
  });
  it("lifts keyframeFileId into keyframeGen.start_frame", () => {
    const out = migrateCardGeneration({ ...base, keyframeFileId: "file_kf" });
    expect(out.keyframeGen?.params.start_frame).toBe("file_kf");
  });
  it("is idempotent — already-migrated cards pass through unchanged", () => {
    const migrated = migrateCardGeneration({ ...base, clipFileId: "f" });
    expect(migrateCardGeneration(migrated)).toEqual(migrated);
  });
  it("leaves a bare card (no artifacts) without clips/keyframeGen", () => {
    const out = migrateCardGeneration(base);
    expect(out.clips).toBeUndefined();
    expect(out.keyframeGen).toBeUndefined();
  });
  // Regression: a migrated keyframeGen has empty apiUrl/model (a legacy keyframe
  // has no known endpoint). The card schema must accept it, otherwise the first
  // mutator that persists a migrated card produces a card.json that parseCard
  // rejects on the next read — silently breaking every legacy-keyframe card.
  it("a migrated card round-trips through parseCard (empty-endpoint keyframeGen)", () => {
    const migrated = migrateCardGeneration({ ...base, keyframeFileId: "kf", clipFileId: "cf" });
    expect(() => parseCard(migrated)).not.toThrow();
    const reparsed = parseCard(migrated);
    expect(reparsed.keyframeGen?.params.start_frame).toBe("kf");
    expect(reparsed.clips?.[0]?.fileId).toBe("cf");
  });
});
