import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, loadCard } from "@/lib/storyboard/repo";
import { saveModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import { setStoryboardGeneration } from "@/mcp/tools/storyboard-tools";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

describe("setStoryboardGeneration gate", () => {
  let pieceId: string;
  beforeEach(async () => {
    createTestDb();
    createTempStorageDir();
    pieceId = "piece_set_gen_test";
  });
  afterEach(async () => {
    cleanupTempDir();
    resetTestDb();
  });

  it("returns schema_cache_missing when no cache exists", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const r = await setStoryboardGeneration(
      { pieceId, cardId: card.id, tier: "clip", spec: { apiUrl: "u", model: "m", params: { prompt: "p" } } },
      { pieceId },
    );
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("schema_cache_missing");
  });

  it("returns schema_validation_failed with issues on a bad param", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    await saveModelSchemaCache("u", "m", { apiUrl: "u", model: "m", fields: [{ key: "prompt", type: "text", required: true }] });
    const r = await setStoryboardGeneration(
      { pieceId, cardId: card.id, tier: "clip", spec: { apiUrl: "u", model: "m", params: { bogus: 1 } } },
      { pieceId },
    );
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("schema_validation_failed");
    expect((r.data as { issues?: unknown[] }).issues?.[0]).toMatchObject({ key: "bogus", problem: "unknown_key" });
  });

  it("persists a valid spec", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    await saveModelSchemaCache("u", "m", { apiUrl: "u", model: "m", fields: [{ key: "prompt", type: "text", required: true }] });
    const r = await setStoryboardGeneration(
      { pieceId, cardId: card.id, tier: "clip", spec: { apiUrl: "u", model: "m", params: { prompt: "p" } } },
      { pieceId },
    );
    expect(r.success).toBe(true);
    expect((await loadCard(pieceId, card.id))?.clipGen?.params.prompt).toBe("p");
  });

  describe("aspect_ratio default (piece-aspect gap fix)", () => {
    it("defaults aspect_ratio to the piece's aspect when the endpoint declares the field and the spec omits it", async () => {
      const manifest = await loadManifest(pieceId);
      await saveManifest(pieceId, { ...manifest, width: 1080, height: 1920 });
      const card = await addStoryboardCard(pieceId, { title: "c" });
      await saveModelSchemaCache("u", "m", {
        apiUrl: "u",
        model: "m",
        fields: [
          { key: "prompt", type: "text", required: true },
          { key: "aspect_ratio", type: "enum", options: ["16:9", "9:16", "1:1"] },
        ],
      });
      const r = await setStoryboardGeneration(
        { pieceId, cardId: card.id, tier: "clip", spec: { apiUrl: "u", model: "m", params: { prompt: "p" } } },
        { pieceId },
      );
      expect(r.success).toBe(true);
      expect((await loadCard(pieceId, card.id))?.clipGen?.params.aspect_ratio).toBe("9:16");
    });

    it("never overrides an explicit aspect_ratio, even a deliberately mismatched one", async () => {
      const manifest = await loadManifest(pieceId);
      await saveManifest(pieceId, { ...manifest, width: 1080, height: 1920 });
      const card = await addStoryboardCard(pieceId, { title: "c" });
      await saveModelSchemaCache("u", "m", {
        apiUrl: "u",
        model: "m",
        fields: [
          { key: "prompt", type: "text", required: true },
          { key: "aspect_ratio", type: "enum", options: ["16:9", "9:16", "1:1"] },
        ],
      });
      const r = await setStoryboardGeneration(
        {
          pieceId,
          cardId: card.id,
          tier: "clip",
          spec: { apiUrl: "u", model: "m", params: { prompt: "p", aspect_ratio: "16:9" } },
        },
        { pieceId },
      );
      expect(r.success).toBe(true);
      expect((await loadCard(pieceId, card.id))?.clipGen?.params.aspect_ratio).toBe("16:9");
    });

    it("leaves aspect_ratio unset when the endpoint doesn't declare the field (never injects an unknown param)", async () => {
      const manifest = await loadManifest(pieceId);
      await saveManifest(pieceId, { ...manifest, width: 1080, height: 1920 });
      const card = await addStoryboardCard(pieceId, { title: "c" });
      await saveModelSchemaCache("u", "m", {
        apiUrl: "u",
        model: "m",
        fields: [{ key: "prompt", type: "text", required: true }],
      });
      const r = await setStoryboardGeneration(
        { pieceId, cardId: card.id, tier: "clip", spec: { apiUrl: "u", model: "m", params: { prompt: "p" } } },
        { pieceId },
      );
      expect(r.success).toBe(true);
      const persisted = (await loadCard(pieceId, card.id))?.clipGen?.params ?? {};
      expect(Object.prototype.hasOwnProperty.call(persisted, "aspect_ratio")).toBe(false);
    });
  });
});
