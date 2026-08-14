/**
 * AI-generation provenance metadata persisted on `files.ai_generation` (JSON).
 *
 * Populated by any MCP tool that generates a file via an external (or
 * placeholder) AI service — fal-ai (including fake-fal in test mode),
 * elevenlabs, local-tts, local-music, etc. NULL for files produced by
 * upload, trim, concat, etc.
 *
 * Surfaced in the Asset Preview Panel's "Generation" tab so creators can
 * inspect the recipe (model, prompt, duration, cost) when debugging a result.
 * Also readable by the agent to find canonical takes in retry loops.
 */
import { z } from "zod/v3";

export const aiGenerationCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().min(1).default("USD"),
  /** Optional pricing tier label (e.g. "veo-3.1-fast/720p/9:16"). */
  tier: z.string().optional(),
});

export const aiGenerationCostActualSchema = aiGenerationCostSchema.extend({
  /**
   * Where the actual cost came from. "tool" means a provider tool returned
   * it (preferred), "page-scrape" means we read it off a billing page,
   * "manual" means the user entered it.
   */
  source: z.enum(["tool", "page-scrape", "manual"]),
});

export const aiGenerationMetaSchema = z.object({
  /**
   * MCP server id (e.g. "fal-ai", "elevenlabs"). Matches the `id` column on
   * the mcp_servers table. In test mode fake-fal masquerades as "fal-ai", so
   * test-mode files also carry provider "fal-ai".
   */
  provider: z.string().min(1),
  /**
   * Model identifier within the provider (e.g. "veo3.1-fast", "kokoro-82m").
   * In test mode fake-fal uses "test-mode" as the model id.
   */
  model: z.string().min(1),
  /**
   * The full engineered prompt actually sent to the model. NOT the user's
   * original ask — this is the structured/expanded prompt after the
   * ai-asset-generation skill's Step 7 build.
   */
  prompt: z.string(),
  /** Cost we estimated BEFORE running. May be omitted in test mode. */
  costEstimate: aiGenerationCostSchema.optional(),
  /** Cost the provider charged AFTER completion. Fetched lazily on demand. */
  costActual: aiGenerationCostActualSchema.optional(),
  /** ISO timestamps. */
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  /** Wall-clock generation duration. */
  durationMs: z.number().nonnegative(),
  /** Provider-side job/run id, when available (e.g. fal job id). */
  providerJobId: z.string().optional(),
  /** Retry / variant counter for this beat. 0 = first attempt. */
  attemptNumber: z.number().int().nonnegative().optional(),
});

export type AiGenerationMeta = z.infer<typeof aiGenerationMetaSchema>;
export type AiGenerationCost = z.infer<typeof aiGenerationCostSchema>;
export type AiGenerationCostActual = z.infer<typeof aiGenerationCostActualSchema>;

/**
 * Serialize for `files.ai_generation` column. Returns null when called with
 * null/undefined so callers can `aiGeneration: serialize(meta ?? null)`.
 */
export function serializeAiGenerationMeta(meta: AiGenerationMeta | null | undefined): string | null {
  if (!meta) return null;
  return JSON.stringify(aiGenerationMetaSchema.parse(meta));
}

/**
 * Parse `files.ai_generation` column. Tolerant of legacy / malformed JSON
 * (returns null in that case) so the panel doesn't crash on bad rows.
 */
export function parseAiGenerationMeta(raw: string | null | undefined): AiGenerationMeta | null {
  if (!raw) return null;
  try {
    return aiGenerationMetaSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
