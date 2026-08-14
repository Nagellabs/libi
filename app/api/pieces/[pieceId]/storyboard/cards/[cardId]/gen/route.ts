import { NextResponse } from "next/server";
import { updateGenParam, loadCard } from "@/lib/storyboard/repo";
import { getModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import { validateParams } from "@/lib/storyboard/gen-schema";
import type { GenParamValue } from "@/lib/storyboard/types";

type Body = { tier?: "keyframe" | "clip"; paramKey?: string; value?: GenParamValue | null };

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string }> },
) {
  const { pieceId, cardId } = await ctx.params;
  const { tier, paramKey, value } = (await req.json().catch(() => ({}))) as Body;
  if ((tier !== "keyframe" && tier !== "clip") || !paramKey) {
    return NextResponse.json({ error: "tier and paramKey required" }, { status: 400 });
  }

  // Validate the single value against the cached schema when both the cache and a
  // matching field def exist. A clear (value === null) never needs validation.
  if (value !== null && value !== undefined) {
    const card = await loadCard(pieceId, cardId);
    const spec = tier === "keyframe" ? card?.keyframeGen : card?.clipGen;
    if (spec?.apiUrl) {
      const cache = await getModelSchemaCache(spec.apiUrl, spec.model);
      const def = cache.schema?.fields.find((f) => f.key === paramKey);
      if (def) {
        const issues = validateParams({ [paramKey]: value }, [def]).filter((i) => i.key === paramKey);
        if (issues.length) {
          return NextResponse.json(
            { error: "schema_validation_failed", issues },
            { status: 422 },
          );
        }
      }
    }
  }

  const updated = await updateGenParam(pieceId, cardId, tier, paramKey, value ?? null);
  if (!updated) return NextResponse.json({ error: "card or spec not found" }, { status: 404 });
  return NextResponse.json({ card: updated });
}
