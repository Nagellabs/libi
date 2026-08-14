import { scriptSchema, type Script } from "./schemas";

export interface ScriptProviderMetaInput {
  providerName: string;
  modelId?: string;
  generatedAt: string;
  /** Dollar cost of this generation (real or estimated). Omit / `null` if unknown. */
  costUsd?: number | null;
  /** True when costUsd is a heuristic estimate, false when from the billing API. */
  costEstimated?: boolean;
  /** Provider's request id, persisted so the refresh-cost endpoint can later
   *  look up the real billed amount. */
  requestId?: string;
  /** ISO timestamp of last refresh attempt. Absent before any check. */
  costLastCheckedAt?: string;
}

export type ParseScriptResult =
  | { ok: true; script: Script }
  | { ok: false; error: string };

const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/;

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(FENCE_RE);
  return m ? m[1] : trimmed;
}

export function parseAndValidateScript(
  raw: string,
  providerMeta: ScriptProviderMetaInput,
): ParseScriptResult {
  const stripped = stripFences(raw);

  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(stripped);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { ok: false, error: `Expected JSON object, got ${typeof json}` };
    }
    parsed = json as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `JSON.parse failed: ${(err as Error).message}` };
  }

  // The runner is the source of truth for provider metadata. Anything the
  // model wrote into `provider` is overwritten — never trusted.
  parsed.provider = {
    name: providerMeta.providerName,
    model: providerMeta.modelId,
    generatedAt: providerMeta.generatedAt,
    costUsd: providerMeta.costUsd ?? null,
    costEstimated: providerMeta.costEstimated ?? false,
    ...(providerMeta.requestId !== undefined && { requestId: providerMeta.requestId }),
    ...(providerMeta.costLastCheckedAt !== undefined && {
      costLastCheckedAt: providerMeta.costLastCheckedAt,
    }),
  };

  const result = scriptSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, script: result.data };
}
