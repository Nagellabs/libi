// app/api/pieces/[pieceId]/storyboard/route.ts
import { NextResponse } from "next/server";
import { loadStoryboard, updateManifestLayout } from "@/lib/storyboard/repo";
import { resolveInheritedRefs } from "@/lib/storyboard/resolve-refs";
import { getModelSchemaCache } from "@/lib/storyboard/model-schema-cache";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await ctx.params;
  const sb = await loadStoryboard(pieceId);
  if (!sb) return NextResponse.json({ storyboard: null, schemas: {} });
  const resolvedCards = sb.cards.map((c) => resolveInheritedRefs(c, sb.cards));
  const schemas: Record<string, { apiUrl: string; model: string; lookup: Awaited<ReturnType<typeof getModelSchemaCache>> }> = {};
  for (const c of resolvedCards) {
    for (const spec of [c.keyframeGen, c.clipGen]) {
      if (!spec || !spec.apiUrl) continue;
      const k = `${spec.apiUrl}::${spec.model}`;
      if (!schemas[k]) schemas[k] = { apiUrl: spec.apiUrl, model: spec.model, lookup: await getModelSchemaCache(spec.apiUrl, spec.model) };
    }
  }
  return NextResponse.json({ storyboard: { ...sb, cards: resolvedCards }, schemas });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { layout?: { positions: Record<string, { x: number; y: number }> } }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.layout) await updateManifestLayout(pieceId, body.layout);
  return NextResponse.json({ ok: true });
}
