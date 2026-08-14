// __tests__/integration/storyboard/patch.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadCard, loadStoryboard } from "@/lib/storyboard/repo";
import { updateCardFields, updateManifestLayout, type CardPatch } from "@/lib/storyboard/repo";
import type { Storyboard } from "@/lib/storyboard/types";

afterEach(() => cleanupTempDir());

const sb: Storyboard = {
  version: 2, cardOrder: ["c1"], updatedAt: "t",
  cards: [{ id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" },
    promptFragment: "x", stage: "schematic", approvals: {} }],
};

describe("storyboard PATCH repo helpers", () => {
  it("updateCardFields merges blocks + promptFragment, leaves others", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const updated = await updateCardFields("p1", "c1", {
      promptFragment: "new prompt",
      blocks: [{ id: "b1", kind: "subject", label: "x", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1 }],
    });
    expect(updated?.promptFragment).toBe("new prompt");
    expect(updated?.blocks).toHaveLength(1);
    expect(updated?.title).toBe("Hook"); // untouched
  });
  it("runtime whitelist blocks ladder-owned fields from being overwritten", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const original = await loadCard("p1", "c1");
    const updated = await updateCardFields("p1", "c1", {
      title: "new",
      // Inject non-whitelisted fields via a forced cast — simulates a raw HTTP PATCH
      stage: "clip",
      approvals: { clip: true },
      keyframeFileId: "hack",
    } as CardPatch);
    expect(updated?.title).toBe("new");               // whitelisted — should change
    expect(updated?.stage).toBe(original?.stage);     // NOT whitelisted — must not change
    expect(updated?.approvals?.clip).toBeUndefined(); // NOT whitelisted — must not change
    expect(updated?.keyframeFileId).toBeUndefined();  // NOT whitelisted — must not change
  });
  it("rejects an unknown card", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    expect(await updateCardFields("p1", "nope", { promptFragment: "x" })).toBeNull();
  });
  it("updateManifestLayout persists node positions", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    await updateManifestLayout("p1", { positions: { c1: { x: 10, y: 20 } } });
    expect((await loadStoryboard("p1"))?.layout?.positions.c1).toEqual({ x: 10, y: 20 });
  });
});
