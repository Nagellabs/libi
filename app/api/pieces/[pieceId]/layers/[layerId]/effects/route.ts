import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { applyLayerEffect, clearLayerEffect } from "@/mcp/tools/effect-tools";

const phaseSchema = z.enum(["in", "out", "loop"]);

const applyBodySchema = z.object({
  phase: phaseSchema,
  effectId: z.string().min(1),
  durationMs: z.number().positive().optional(),
  params: z.record(z.union([z.number(), z.string()])).optional(),
});

type RouteCtx = { params: Promise<{ pieceId: string; layerId: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const { pieceId, layerId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = applyBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }
  const result = await applyLayerEffect({
    pieceId,
    layerId,
    phase: parsed.data.phase,
    effectId: parsed.data.effectId,
    durationMs: parsed.data.durationMs,
    params: parsed.data.params,
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error, ...result.data }, { status: 400 });
  }
  return NextResponse.json({ success: true, layerKind: result.data?.layerKind });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { pieceId, layerId } = await ctx.params;
  const phaseRaw = new URL(req.url).searchParams.get("phase");
  const phase = phaseSchema.safeParse(phaseRaw);
  if (!phase.success) {
    return NextResponse.json({ error: "invalid_phase" }, { status: 400 });
  }
  const result = await clearLayerEffect({ pieceId, layerId, phase: phase.data });
  if (!result.success) {
    return NextResponse.json({ error: result.error, ...result.data }, { status: 400 });
  }
  return NextResponse.json({ success: true, layerKind: result.data?.layerKind });
}
