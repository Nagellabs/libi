// __tests__/integration/storyboard/get-enrichment.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, appendClipTake, setCardGeneration, setCardReference } from "@/lib/storyboard/repo";
import { saveModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import { GET } from "@/app/api/pieces/[pieceId]/storyboard/route";

describe("GET /storyboard enrichment", () => {
  beforeEach(() => {
    createTestDb();
    createTempStorageDir();
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
  });

  it("returns resolved inherited refs + a schemas map", async () => {
    const pieceId = "p-enrich";
    const prev = await addStoryboardCard(pieceId, { title: "prev" });
    await appendClipTake(pieceId, prev.id, "PREVFILE");
    // Select the clip take so it becomes the selected take
    const { loadCard, selectClipTake } = await import("@/lib/storyboard/repo");
    const prevCard = (await loadCard(pieceId, prev.id))!;
    const takeId = prevCard.clips![0].id;
    await selectClipTake(pieceId, prev.id, takeId);

    const cur = await addStoryboardCard(pieceId, { title: "cur" });
    await saveModelSchemaCache("u", "m", {
      apiUrl: "u",
      model: "m",
      fields: [
        { key: "prompt", type: "text" },
        { key: "reference_video", type: "video" },
      ],
    });
    await setCardGeneration(pieceId, cur.id, "clip", {
      apiUrl: "u",
      model: "m",
      params: { prompt: "p" },
    });
    await setCardReference(pieceId, cur.id, "reference_video", { fromCardId: prev.id });

    const res = await GET(new Request("http://x"), {
      params: Promise.resolve({ pieceId }),
    });
    const body = await res.json();
    const curCard = body.storyboard.cards.find((c: { id: string }) => c.id === cur.id);
    expect(curCard.clipGen.params.reference_video).toBe("PREVFILE");
    expect(body.schemas["u::m"].lookup.exists).toBe(true);
  });

  it("returns { storyboard: null, schemas: {} } when no storyboard exists", async () => {
    const res = await GET(new Request("http://x"), {
      params: Promise.resolve({ pieceId: "no-such-piece" }),
    });
    const body = await res.json();
    expect(body.storyboard).toBeNull();
    expect(body.schemas).toEqual({});
  });
});
