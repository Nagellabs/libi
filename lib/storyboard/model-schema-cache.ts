import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { modelSchemas } from "@/lib/db/schema/sqlite";
import type { ModelSchema } from "./gen-schema";

/** 10-day TTL in milliseconds */
export const SCHEMA_CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;

export type CacheLookup = {
  exists: boolean;
  stale?: boolean;
  fetchedAt?: number;
  schema?: ModelSchema;
};

function cacheId(apiUrl: string, model: string): string {
  return `${apiUrl}::${model}`;
}

/** Look up a cached ModelSchema by (apiUrl, model).
 *  Returns `{ exists: false }` when nothing is cached.
 *  Returns `{ exists: true, stale: true }` when the entry is older than SCHEMA_CACHE_TTL_MS. */
export async function getModelSchemaCache(apiUrl: string, model: string): Promise<CacheLookup> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modelSchemas)
    .where(and(eq(modelSchemas.apiUrl, apiUrl), eq(modelSchemas.model, model)))
    .limit(1);
  const row = rows[0];
  if (!row) return { exists: false };
  // fetchedAt is stored as timestamp_ms — Drizzle returns a Date in timestamp_ms mode
  const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt.getTime() : Number(row.fetchedAt);
  let schema: ModelSchema;
  try {
    schema = JSON.parse(row.schemaJson) as ModelSchema;
  } catch {
    return { exists: false };
  }
  return {
    exists: true,
    stale: Date.now() - fetchedAt > SCHEMA_CACHE_TTL_MS,
    fetchedAt,
    schema,
  };
}

/** Upsert a ModelSchema keyed by (apiUrl, model).
 *
 * @param fetchedAtOverride - Test-only: override the stored timestamp to simulate a stale entry.
 */
export async function saveModelSchemaCache(
  apiUrl: string,
  model: string,
  schema: ModelSchema,
  source?: string,
  fetchedAtOverride?: Date,
): Promise<void> {
  const db = getDb();
  const now = fetchedAtOverride ?? new Date();
  await db
    .insert(modelSchemas)
    .values({
      id: cacheId(apiUrl, model),
      apiUrl,
      model,
      schemaJson: JSON.stringify(schema),
      source: source ?? null,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: modelSchemas.id,
      set: {
        schemaJson: JSON.stringify(schema),
        source: source ?? null,
        fetchedAt: now,
      },
    });
}

/** Delete the cached entry for (apiUrl, model), if any. */
export async function invalidateModelSchemaCache(apiUrl: string, model: string): Promise<void> {
  const db = getDb();
  await db.delete(modelSchemas).where(eq(modelSchemas.id, cacheId(apiUrl, model)));
}
