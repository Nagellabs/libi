import { NextResponse } from "next/server";
import {
  listOverlayPresets,
  saveOverlayPreset,
} from "@/mcp/tools/overlay-preset-tools";
import { listOverlayPresetsSchema } from "@/mcp/tools/schemas";

/**
 * GET /api/overlay-presets?kind=text
 *
 * List bundled + user overlay presets, optionally filtered by overlay kind.
 * Returns `{ presets }`. Thin wrapper over the `listOverlayPresets` tool fn.
 */
export async function GET(request: Request) {
  const rawKind = new URL(request.url).searchParams.get("kind") ?? undefined;
  // Validate `kind` against the tool schema (unknown kinds drop to undefined).
  const parsed = listOverlayPresetsSchema.safeParse({ kind: rawKind });
  const kind = parsed.success ? parsed.data.kind : undefined;
  const result = await listOverlayPresets({ kind });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(result.data, { status: 200 });
}

/**
 * POST /api/overlay-presets
 *
 * Body: `{ pieceId, overlayId, name, override? }`. Captures an overlay's
 * reusable styling/animation/transform/effects fields as a named user preset
 * and returns `{ presetId }`. Maps `overlay_not_found` → 404,
 * `preset_name_exists`/`preset_name_reserved` → 409, other failures → 400.
 */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = raw as { pieceId?: string; overlayId?: string; name?: string; override?: boolean };
  if (!body.pieceId || !body.overlayId || !body.name) {
    return NextResponse.json(
      { error: "pieceId, overlayId, and name are required" },
      { status: 400 },
    );
  }

  const result = await saveOverlayPreset({
    pieceId: body.pieceId,
    overlayId: body.overlayId,
    name: body.name,
    override: body.override === true,
  });
  if (!result.success) {
    const status =
      result.error === "overlay_not_found" ? 404
      : result.error === "preset_name_exists" || result.error === "preset_name_reserved" ? 409
      : 400;
    return NextResponse.json({ error: result.error, ...(result.data ?? {}) }, { status });
  }
  return NextResponse.json(result.data, { status: 200 });
}
