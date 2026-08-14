import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import {
  addStoryboardCard,
  setCardGeneration,
  appendClipTake,
  selectClipTake,
  hideClipTake,
  setCardReference,
  loadCard,
} from "@/lib/storyboard/repo";
import { resolveInheritedRefs } from "@/lib/storyboard/resolve-refs";
import type { StoryboardCard } from "@/lib/storyboard/types";

describe("generation repo mutators", () => {
  let pieceId: string;

  beforeEach(() => {
    createTempStorageDir();
    pieceId = "piece_gen_test";
  });

  afterEach(() => cleanupTempDir());

  it("sets a clip generation spec", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    await setCardGeneration(pieceId, card.id, "clip", { apiUrl: "u", model: "m", params: { prompt: "p", duration: 8 } });
    const out = await loadCard(pieceId, card.id);
    expect(out?.clipGen).toEqual({ apiUrl: "u", model: "m", params: { prompt: "p", duration: 8 } });
  });

  it("appends versioned takes and auto-selects the first", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const t1 = await appendClipTake(pieceId, card.id, "file1", 0.3);
    const t2 = await appendClipTake(pieceId, card.id, "file2", 0.3);
    const out = await loadCard(pieceId, card.id);
    expect(out?.clips?.map((c) => c.label)).toEqual(["v1", "v2"]);
    expect(out?.selectedClipId).toBe(t1!.id);
    expect(t2!.label).toBe("v2");
  });

  it("selects a take", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    await appendClipTake(pieceId, card.id, "file1");
    const t2 = await appendClipTake(pieceId, card.id, "file2");
    await selectClipTake(pieceId, card.id, t2!.id);
    expect((await loadCard(pieceId, card.id))?.selectedClipId).toBe(t2!.id);
  });

  it("soft-hides a take and reselects another when the selected one is hidden", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const t1 = await appendClipTake(pieceId, card.id, "file1");
    const t2 = await appendClipTake(pieceId, card.id, "file2");
    await selectClipTake(pieceId, card.id, t1!.id);
    await hideClipTake(pieceId, card.id, t1!.id);
    const out = await loadCard(pieceId, card.id);
    expect(out?.clips?.find((c) => c.id === t1!.id)?.hidden).toBe(true);
    expect(out?.selectedClipId).toBe(t2!.id);
  });

  it("refuses to select a hidden take", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const t1 = await appendClipTake(pieceId, card.id, "file1");
    const t2 = await appendClipTake(pieceId, card.id, "file2");
    await hideClipTake(pieceId, card.id, t2!.id);
    const res = await selectClipTake(pieceId, card.id, t2!.id);
    expect(res).toBeNull();
    // selection unchanged (still the auto-selected first take)
    expect((await loadCard(pieceId, card.id))?.selectedClipId).toBe(t1!.id);
  });

  it("sets an inherited reference link", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    await setCardReference(pieceId, card.id, "reference_video", { fromCardId: "card_prev" });
    expect((await loadCard(pieceId, card.id))?.inheritedRefs?.reference_video).toEqual({ fromCardId: "card_prev" });
  });
});

describe("resolveInheritedRefs", () => {
  it("injects the source card's selected take fileId into params", () => {
    const prev = { id: "p", clips: [{ id: "t1", fileId: "F1", label: "v1", createdAt: 0 }], selectedClipId: "t1" } as unknown as StoryboardCard;
    const cur = { id: "c", clipGen: { apiUrl: "u", model: "m", params: { prompt: "p" } }, inheritedRefs: { reference_video: { fromCardId: "p" } } } as unknown as StoryboardCard;
    const resolved = resolveInheritedRefs(cur, [prev, cur]);
    expect(resolved.clipGen?.params.reference_video).toBe("F1");
  });
  it("omits the param when the source has no selected take", () => {
    const prev = { id: "p", clips: [] } as unknown as StoryboardCard;
    const cur = { id: "c", clipGen: { apiUrl: "u", model: "m", params: {} }, inheritedRefs: { reference_video: { fromCardId: "p" } } } as unknown as StoryboardCard;
    const resolved = resolveInheritedRefs(cur, [prev, cur]);
    expect(resolved.clipGen?.params.reference_video).toBeUndefined();
  });
});
