import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { Overlay, VideoOverlay } from "@/lib/engine/types";

/**
 * Attach each video overlay's SOURCE pixel dimensions from the `files` table.
 *
 * The server-side export routes hydrate a `Composition` straight from the
 * persisted manifest, which carries no source dims — but the classifier needs
 * them to know whether `-c copy` (which cannot scale) would preserve the
 * composition's framing. Without this the server would classify a mismatched
 * base differently from the client (which gets dims via `buildComposition`),
 * and the route's second-pass shape check would 409 instead of exporting.
 *
 * Unknown / unprobed rows yield `null`, which the classifier reads as a
 * mismatch (see `streamCopyPreservesFraming`).
 */
export function attachOverlaySourceDims(overlays: Overlay[]): Overlay[] {
  const fileIds = Array.from(
    new Set(overlays.filter((o): o is VideoOverlay => o.kind === "video").map((o) => o.fileId)),
  );
  if (fileIds.length === 0) return overlays;

  const rows = getDb().select().from(files).where(inArray(files.id, fileIds)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));

  return overlays.map((o) => {
    if (o.kind !== "video") return o;
    const f = byId.get(o.fileId);
    return {
      ...o,
      sourceWidth: f?.mediaWidth ?? null,
      sourceHeight: f?.mediaHeight ?? null,
    } satisfies VideoOverlay;
  });
}
