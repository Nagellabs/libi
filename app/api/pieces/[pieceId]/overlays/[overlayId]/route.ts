import { NextResponse } from "next/server";
import { updateOverlay } from "@/mcp/tools/overlay-tools";
import { navigationEmitter } from "@/lib/navigation-events";
import { updateOverlaySchema } from "@/mcp/tools/schemas";
import { loadManifest } from "@/lib/composition/persistence";

interface RouteParams {
  params: Promise<{ pieceId: string; overlayId: string }>;
}

/** Body shape — updateOverlaySchema minus the id fields pulled from the URL. */
const UpdateOverlayBodySchema = updateOverlaySchema.omit({
  pieceId: true,
  overlayId: true,
});

/**
 * PATCH /api/pieces/[pieceId]/overlays/[overlayId]
 *
 * Update a text overlay's fields. Called by the editor page's inline
 * text editor on commit. Body fields are all optional — whatever the
 * UI edited. Validates the body against UpdateTextOverlayBodySchema
 * before writing so a malformed client (or a stray PATCH) can't poison
 * the manifest with wrong-shape fields.
 *
 * Returns: 200 with `{ success, overlayId }`, 400 on invalid JSON / body
 * shape, 404 on missing overlay.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { pieceId, overlayId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateOverlayBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await updateOverlay({
    ...parsed.data,
    pieceId,
    overlayId,
  });

  if (!result.success) {
    return NextResponse.json(result, { status: 404 });
  }

  // Fire the same refresh hook the MCP tool's refresh-hook uses so the
  // editor's composition query invalidates and re-renders.
  try {
    navigationEmitter.emit("refresh_query", {
      queryKey: "composition",
      pieceId,
    });
  } catch {
    /* fire-and-forget */
  }

  // Echo the saved overlay's monotonic version so the client edit store can
  // reconcile (drop a pending local edit only once it sees version >= the one
  // it wrote). Best-effort: a read miss simply omits it.
  let version: number | undefined;
  try {
    const manifest = await loadManifest(pieceId);
    const saved = manifest.overlays?.find((o) => o.id === overlayId) as
      | { version?: number }
      | undefined;
    version = saved?.version;
  } catch {
    /* best-effort — omit version on read failure */
  }

  return NextResponse.json({ ...result, ...(version !== undefined ? { version } : {}) });
}
