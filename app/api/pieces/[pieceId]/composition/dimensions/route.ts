import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { setCompositionDimensions } from "@/lib/composition/dimensions";
import { serverLogger as logger } from "@/lib/logger";

const bodySchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * Set a piece's canvas dimensions directly.
 *
 * The UI only reaches this for a piece with NO overlays — there is nothing to
 * reflow, so an agent round-trip would add a chat message and a wait for a
 * change that cannot go wrong. A piece with content goes through the agent
 * instead, which repositions the overlays as part of the same job.
 *
 * That "no overlays" rule is a UI ROUTING CONVENTION, not something this route
 * enforces, and deliberately so. `libi.update_composition_dimensions` resizes a
 * piece with content by design — that is exactly what the dispatched flow asks
 * the agent to do — so rejecting it here would make the HTTP path stricter than
 * the agent path without being a boundary, since the agent path is always open.
 * A resize that strands overlays is not silent either way: the shared
 * setCompositionDimensions returns a warning naming every overlay left outside
 * the new frame.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pieceId: string }> },
): Promise<Response> {
  const { pieceId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const [piece] = db.select().from(pieces).where(eq(pieces.id, pieceId)).limit(1).all();
    if (!piece) {
      return NextResponse.json({ error: "piece not found" }, { status: 404 });
    }

    const result = await setCompositionDimensions(
      pieceId,
      parsed.data.width,
      parsed.data.height,
    );
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      {
        tag: "composition",
        op: "patch_dimensions_failed",
        pieceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to set composition dimensions",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
