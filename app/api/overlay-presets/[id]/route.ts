import { NextResponse } from "next/server";
import { deleteOverlayPreset } from "@/mcp/tools/overlay-preset-tools";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * DELETE /api/overlay-presets/[id]
 *
 * Remove a user-saved preset (bundled ids are a no-op). Returns
 * `{ success: true }`.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const result = await deleteOverlayPreset({ presetId: id });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true }, { status: 200 });
}
