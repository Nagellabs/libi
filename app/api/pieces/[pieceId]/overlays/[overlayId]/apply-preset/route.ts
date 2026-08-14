import { NextResponse } from "next/server";
import { applyOverlayPreset } from "@/mcp/tools/overlay-preset-tools";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ pieceId: string; overlayId: string }>;
}

/**
 * POST /api/pieces/[pieceId]/overlays/[overlayId]/apply-preset
 *
 * Body: `{ presetId }`. Merges the preset's captured fields onto the overlay.
 * On success emits the same `refresh_query composition` hook the overlay tools
 * use so the editor re-renders. Maps `preset_not_found`/`overlay_not_found` →
 * 404, `kind_mismatch` → 409, other failures → 400.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { pieceId, overlayId } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const presetId = (raw as { presetId?: string }).presetId;
  if (!presetId) {
    return NextResponse.json({ error: "presetId is required" }, { status: 400 });
  }

  const result = await applyOverlayPreset({ pieceId, overlayId, presetId });
  if (!result.success) {
    if (result.error === "preset_not_found" || result.error === "overlay_not_found") {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    if (result.error === "kind_mismatch") {
      return NextResponse.json(
        { error: result.error, ...(result.data ?? {}) },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  } catch {
    /* fire-and-forget */
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
