import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { loadManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { overlayCodeFilePath } from "@/lib/overlays/code-files";
import { bodyHashesOf } from "@/lib/render/body-hashes";
import {
  getRenderDiagnostics,
  getUnattributedDiagnostics,
  hasRenderDiagnostics,
  MAX_DIAGNOSTICS_PER_PIECE,
  MAX_UNATTRIBUTED_PER_PIECE,
  renderDiagnosticSchema,
  setRenderDiagnostics,
  setUnattributedDiagnostics,
  unattributedDiagnosticSchema,
  type RenderDiagnosticRecord,
} from "@/lib/render/render-diagnostics-store";
import { serverLogger as logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

const putSchema = z.object({
  diagnostics: z.array(renderDiagnosticSchema).max(MAX_DIAGNOSTICS_PER_PIECE),
  unattributed: z.array(unattributedDiagnosticSchema).max(MAX_UNATTRIBUTED_PER_PIECE).optional(),
});

function pieceExists(pieceId: string): boolean {
  return getDb().select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).get() !== undefined;
}

/** The open preview's debounced "here is every body failure right now"
 *  (spec §4.7). A replace of the PREVIEW's own list — an empty set clears what
 *  the preview reported, never what an export or render_overlay_frames found
 *  (the store keeps the two apart). Strict: at most
 *  MAX_DIAGNOSTICS_PER_PIECE entries (the client caps what it sends), and only
 *  for a piece that exists — a preview's last flush after its piece was
 *  deleted must not bring the entry back. */
export async function PUT(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // The client swallows a failed PUT (the badge still shows it), so this
    // line is the only trace of a preview whose reports stopped landing.
    logger.warn(
      { tag: "overlay-sandbox", op: "diagnostics_put_rejected", pieceId, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) },
      "overlay-sandbox: diagnostics PUT rejected",
    );
    return NextResponse.json({ error: "Invalid body", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  if (!pieceExists(pieceId)) {
    return NextResponse.json({ error: "Piece not found" }, { status: 404 });
  }
  const { diagnostics, unattributed = [] } = parsed.data;
  setRenderDiagnostics(pieceId, diagnostics);
  setUnattributedDiagnostics(pieceId, unattributed);
  if (diagnostics.length || unattributed.length) {
    logger.info(
      {
        tag: "overlay-sandbox",
        op: "diagnostics_put",
        pieceId,
        count: diagnostics.length,
        unattributed: unattributed.length,
        overlayIds: diagnostics.map((d) => d.overlayId),
      },
      "overlay-sandbox: diagnostics recorded",
    );
  }
  return new Response(null, { status: 204 });
}

/** What libi.get_piece_state reads (from the MCP child, over HTTP), with the
 *  absolute code file path so the agent can open and fix it. An export's entry
 *  is returned only while its body is still the overlay's draft body. */
export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const unattributed = getUnattributedDiagnostics(pieceId);
  if (!hasRenderDiagnostics(pieceId)) return NextResponse.json({ diagnostics: [], unattributed });
  let overlays = new Map<string, PersistedOverlay>();
  let hashes: Map<string, string> | null = null;
  try {
    const manifest = await loadManifest(pieceId);
    overlays = new Map((manifest.overlays ?? []).map((o) => [o.id, o]));
    hashes = await bodyHashesOf(manifest.overlays ?? []);
  } catch (err) {
    // No manifest to resolve files against: the diagnostics still go out.
    logger.warn({ tag: "overlay-sandbox", op: "diagnostics_manifest_failed", pieceId, err }, "overlay-sandbox: manifest unreadable for diagnostics");
  }
  const current = hashes;
  const diagnostics = getRenderDiagnostics(pieceId, current ? (id) => current.get(id) : undefined);
  const records: RenderDiagnosticRecord[] = await Promise.all(
    diagnostics.map(async (d) => {
      const overlay = overlays.get(d.overlayId);
      const file = overlay ? await overlayCodeFilePath(pieceId, overlay) : undefined;
      return file ? { ...d, file } : { ...d };
    }),
  );
  return NextResponse.json({ diagnostics: records, unattributed });
}
