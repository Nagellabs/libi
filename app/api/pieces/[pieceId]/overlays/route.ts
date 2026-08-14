import { NextResponse } from "next/server";
import { z } from "zod";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const sharedFields = {
  startTime: z.number().min(0),
  duration: z.number().positive(),
  rect: rectSchema,
  z: z.number().default(0),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  group: z.string().max(120).optional(),
};

/** UI create accepts only the three direct kinds; code/three go via the agent. */
const CreateBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    ...sharedFields,
    content: z.string().max(5000),
    font: z.string().max(200).default("48px Inter"),
    color: z.string().max(64).default("#ffffff"),
    align: z.enum(["left", "center", "right"]).default("center"),
  }),
  z.object({ kind: z.literal("image"), ...sharedFields, fileId: z.string() }),
  z.object({
    kind: z.literal("video"),
    ...sharedFields,
    fileId: z.string(),
    trim: z.object({ start: z.number(), end: z.number() }).optional(),
  }),
]);

/**
 * POST /api/pieces/[pieceId]/overlays — create a text/image/video overlay from
 * the UI. Delegates to the `addOverlay` tool fn (persists to the draft manifest
 * + flips has_draft), then fires refresh_query so connected clients refetch.
 * Returns { success, overlayId } so the UI can auto-select.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await addOverlay({ pieceId, ...parsed.data } as never);
  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "add failed" }, { status: 400 });
  }

  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return NextResponse.json({
    success: true,
    overlayId: (result.data as { overlayId?: string } | undefined)?.overlayId,
  });
}
