import { NextResponse } from "next/server";
import { listRecoverableDrafts, RECOVERABLE_DAYS } from "@/lib/composition/lifecycle";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/**
 * The piece's hidden recoverable drafts (newest first): what a Discard or a
 * Restore set aside, kept `days` days. The Version history lists them with a
 * Restore button that posts the `rec-` id to the ordinary restore route.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  try {
    const drafts = await listRecoverableDrafts(pieceId);
    return NextResponse.json({ drafts, days: RECOVERABLE_DAYS });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}
