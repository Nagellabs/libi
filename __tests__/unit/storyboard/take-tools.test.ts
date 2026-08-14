import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, loadCard, setCardGeneration, appendClipTake } from "@/lib/storyboard/repo";
import { saveModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import {
  attachStoryboardClip,
  selectStoryboardTake,
  hideStoryboardTake,
  setStoryboardReference,
  storyboardGet,
} from "@/mcp/tools/storyboard-tools";

describe("take + reference tools and storyboard_get enrichment", () => {
  let pieceId: string;

  beforeEach(() => {
    createTestDb();
    createTempStorageDir();
    pieceId = "piece_take_tools";
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
  });

  it("attach_storyboard_clip appends a versioned take", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const r1 = await attachStoryboardClip({ pieceId, cardId: card.id, fileId: "f1", costUsd: 0.3 }, { pieceId });
    expect(r1.success).toBe(true);
    const take = r1.data?.take as { fileId: string; label: string };
    expect(take.fileId).toBe("f1");
    expect(take.label).toBe("v1");

    await attachStoryboardClip({ pieceId, cardId: card.id, fileId: "f2" }, { pieceId });
    const out = await loadCard(pieceId, card.id);
    expect(out?.clips?.map((c) => c.label)).toEqual(["v1", "v2"]);
  });

  it("select + hide take tools work", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const t1 = await appendClipTake(pieceId, card.id, "f1");
    const t2 = await appendClipTake(pieceId, card.id, "f2");

    await selectStoryboardTake({ pieceId, cardId: card.id, takeId: t2!.id }, { pieceId });
    expect((await loadCard(pieceId, card.id))?.selectedClipId).toBe(t2!.id);

    await hideStoryboardTake({ pieceId, cardId: card.id, takeId: t2!.id }, { pieceId });
    const out = await loadCard(pieceId, card.id);
    expect(out?.clips?.find((c) => c.id === t2!.id)?.hidden).toBe(true);
    // When selected take is hidden, reselects the newest remaining visible take
    expect(out?.selectedClipId).toBe(t1!.id);
  });

  it("select_storyboard_take returns card_or_take_not_found on missing take", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const r = await selectStoryboardTake({ pieceId, cardId: card.id, takeId: "nonexistent" }, { pieceId });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/card or take not found/);
  });

  it("set_storyboard_reference links a card param to another card", async () => {
    const prev = await addStoryboardCard(pieceId, { title: "prev" });
    await appendClipTake(pieceId, prev.id, "PREVFILE");
    const cur = await addStoryboardCard(pieceId, { title: "cur" });

    const r = await setStoryboardReference({ pieceId, cardId: cur.id, paramKey: "reference_video", fromCardId: prev.id }, { pieceId });
    expect(r.success).toBe(true);
    expect(r.data?.cardId).toBe(cur.id);

    const out = await loadCard(pieceId, cur.id);
    expect(out?.inheritedRefs?.reference_video).toEqual({ fromCardId: prev.id });
  });

  it("storyboard_get resolves inherited refs and returns a schemas map", async () => {
    const prev = await addStoryboardCard(pieceId, { title: "prev" });
    await appendClipTake(pieceId, prev.id, "PREVFILE");

    const cur = await addStoryboardCard(pieceId, { title: "cur" });
    await saveModelSchemaCache("u", "m", {
      apiUrl: "u",
      model: "m",
      fields: [
        { key: "prompt", type: "text" },
        { key: "reference_video", type: "video" },
      ],
    });
    await setCardGeneration(pieceId, cur.id, "clip", { apiUrl: "u", model: "m", params: { prompt: "p" } });
    await setStoryboardReference({ pieceId, cardId: cur.id, paramKey: "reference_video", fromCardId: prev.id }, { pieceId });

    const r = await storyboardGet({ pieceId }, { pieceId });
    expect(r.success).toBe(true);
    const data = r.data as {
      storyboard: { cards: Array<{ id: string; clipGen: { params: Record<string, unknown> } }> };
      schemas: Record<string, { lookup: { exists: boolean } }>;
    };

    // The cur card's clipGen.params.reference_video should be resolved to the prev card's selected clip
    const curCard = data.storyboard.cards.find((c) => c.id === cur.id)!;
    expect(curCard.clipGen.params.reference_video).toBe("PREVFILE");

    // schemas map should contain the entry for "u::m"
    expect(data.schemas["u::m"]).toBeDefined();
    expect(data.schemas["u::m"].lookup.exists).toBe(true);
  });
});
