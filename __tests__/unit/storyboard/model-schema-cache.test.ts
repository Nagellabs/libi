import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import {
  getModelSchemaCache,
  saveModelSchemaCache,
  invalidateModelSchemaCache,
  SCHEMA_CACHE_TTL_MS,
} from "@/lib/storyboard/model-schema-cache";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";
import { modelSchemas } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

const schema: ModelSchema = {
  apiUrl: "fal-ai/veo3.1/fast/flf",
  model: "veo3.1-fast",
  fields: [{ key: "prompt", type: "text", required: true }],
};

describe("model-schema cache", () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => resetTestDb());

  it("returns exists:false when nothing cached", async () => {
    const r = await getModelSchemaCache("x", "y");
    expect(r).toEqual({ exists: false });
  });

  it("saves then reads fresh", async () => {
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema, "fal");
    const r = await getModelSchemaCache(schema.apiUrl, schema.model);
    expect(r.exists).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.schema?.fields[0].key).toBe("prompt");
  });

  it("upserts on the same key (no duplicate)", async () => {
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema);
    const updated = { ...schema, fields: [...schema.fields, { key: "seed", type: "number" as const }] };
    await saveModelSchemaCache(schema.apiUrl, schema.model, updated);
    const r = await getModelSchemaCache(schema.apiUrl, schema.model);
    expect(r.schema?.fields).toHaveLength(2);
  });

  it("reports stale past the TTL", async () => {
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema);
    const past = new Date(Date.now() - SCHEMA_CACHE_TTL_MS - 1000);
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema, undefined, past);
    const r = await getModelSchemaCache(schema.apiUrl, schema.model);
    expect(r.stale).toBe(true);
  });

  it("invalidates", async () => {
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema);
    await invalidateModelSchemaCache(schema.apiUrl, schema.model);
    expect((await getModelSchemaCache(schema.apiUrl, schema.model)).exists).toBe(false);
  });

  it("treats a corrupt schemaJson row as a miss (self-healing)", async () => {
    await saveModelSchemaCache(schema.apiUrl, schema.model, schema);
    // Overwrite the row with invalid JSON directly via drizzle
    db.update(modelSchemas)
      .set({ schemaJson: "{not valid json" })
      .where(eq(modelSchemas.apiUrl, schema.apiUrl))
      .run();
    const r = await getModelSchemaCache(schema.apiUrl, schema.model);
    expect(r.exists).toBe(false);
  });
});
