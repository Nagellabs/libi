import type { EffectDef, EffectRef, EffectPhase } from "@/lib/effects/types";

/** One-line summary for an applied effect row: `out · 500ms · up`. Pure. */
export function effectRowSummary(def: EffectDef, ref: EffectRef, phase: EffectPhase): string {
  const parts: string[] = [phase];

  const skipDuration = def.meta.textInternal || def.meta.audioEnvelope;
  const durationMs = ref.durationMs ?? def.meta.defaultDurationMs;
  if (!skipDuration && durationMs != null) parts.push(`${durationMs}ms`);

  const enumParam = def.meta.params.find((p) => p.type === "enum");
  if (enumParam) {
    const value = String(ref.params?.[enumParam.key] ?? enumParam.default ?? enumParam.options?.[0] ?? "");
    if (value) parts.push(value);
  }

  return parts.join(" · ");
}
