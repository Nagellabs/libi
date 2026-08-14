import { scriptSchema, type Script } from "./schemas";
import type { AnalysisStep } from "./types";

/** Coerce a date field that may arrive as a string after JSON serialization
 *  (React Query's JSON.parse never re-hydrates Date objects). */
export function toMs(d: Date | string | null | undefined): number {
  if (!d) return 0;
  if (typeof d === "string") return new Date(d).getTime();
  return d.getTime();
}

export interface PersistedScript {
  step: AnalysisStep;
  script: Script;
  providerId: string;
  modelId: string;
}

export function buildScriptKind(
  providerId: string,
  modelId: string,
): `script:${string}:${string}` {
  const safeModel = modelId.length > 0 ? modelId : "default";
  return `script:${providerId}:${safeModel}` as `script:${string}:${string}`;
}

export function buildCaptionSpecKind(
  providerId: string,
  modelId: string,
): `caption_spec:${string}:${string}` {
  const safeModel = modelId.length > 0 ? modelId : "default";
  return `caption_spec:${providerId}:${safeModel}` as `caption_spec:${string}:${string}`;
}

export function parseScriptStep(step: AnalysisStep): PersistedScript | null {
  if (!step.kind.startsWith("script:")) return null;
  if (step.content === null) return null;

  // kind format: "script:{providerId}:{modelId}" — exactly 3 colon-separated parts.
  const parts = step.kind.split(":");
  if (parts.length !== 3) return null;
  const [, providerId, modelId] = parts;
  if (!providerId || !modelId) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(step.content);
  } catch {
    return null;
  }

  const result = scriptSchema.safeParse(parsed);
  if (!result.success) return null;

  return { step, script: result.data, providerId, modelId };
}

/** Pick the newest `script:*` step from a step list, or undefined if none.
 *  Comparison key is `createdAt` (newest wins). Used by the Script tab to
 *  decide both "is there a script?" and "which one to display". */
export function findLatestScriptStep(
  steps: AnalysisStep[] | undefined,
): AnalysisStep | undefined {
  if (!steps) return undefined;
  let latest: AnalysisStep | undefined;
  for (const s of steps) {
    if (!s.kind.startsWith("script:")) continue;
    if (!latest || toMs(s.createdAt) > toMs(latest.createdAt)) {
      latest = s;
    }
  }
  return latest;
}
