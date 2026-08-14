"use client";

import type { StoryboardCard, GenParamValue } from "@/lib/storyboard/types";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";
import { buildParamView } from "@/lib/storyboard/param-view";
import { ParamList } from "./param-list";

interface GenerationOptionsProps {
  card: StoryboardCard;
  schema?: ModelSchema;
  onEditParam?: (key: string, value: GenParamValue) => void;
  errors?: Record<string, string>;
  onPrefill?: (text: string) => void;
}

export function GenerationOptions({
  card,
  schema,
  onEditParam,
  errors,
  onPrefill: _onPrefill,
}: GenerationOptionsProps) {
  if (!card.clipGen) return null;

  const view = buildParamView(card.clipGen, schema);
  const modelId = card.clipGen.model || card.clipGen.apiUrl;

  return (
    <div>
      {/* Header row: label + model id (clamped to 2 lines, full name on hover) */}
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">Generation options</span>
        <span
          title={modelId}
          className="line-clamp-2 max-w-[55%] text-right font-mono text-[10px] leading-tight text-muted-foreground/70"
        >
          {modelId}
        </span>
      </div>

      <ParamList view={view} onEditParam={onEditParam} errors={errors} />
    </div>
  );
}
