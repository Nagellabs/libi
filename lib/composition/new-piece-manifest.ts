import { EMPTY_MANIFEST, saveManifest } from "@/lib/composition/persistence";
import { saveCurrentSnapshot } from "@/lib/composition/snapshots";
import { getPieceDefaults } from "@/lib/db/settings";
import { dimensionsFor, DEFAULT_ASPECT_RATIO_ID } from "@/lib/composition/aspect-ratio";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Materialise a brand-new piece's manifest + snapshot at the user's default
 * aspect ratio. Shared by every piece-creation path — `POST /api/pieces` and
 * `libi.create_piece` — so a new piece never silently lands at
 * EMPTY_MANIFEST's 1920x1080 landscape default just because one path forgot
 * to call this.
 *
 * Callers MUST have already committed the piece row before calling this: on
 * a storage failure this logs and returns rather than throwing, so the piece
 * stays usable (loadManifest falls back to EMPTY_MANIFEST and initialises a
 * snapshot on first read) instead of turning a committed piece into a 500.
 * Graceful degradation beats a failed creation — the only loss on failure is
 * that the piece opens at the default 1920x1080 instead of the user's chosen
 * ratio.
 */
export async function initializePieceManifest(pieceId: string): Promise<void> {
  const { aspectRatioId } = getPieceDefaults();
  // getPieceDefaults already rejects an id outside the catalog, so the left
  // side does not currently return null — the fallback is a second line of
  // defence, kept because the cost of being wrong is a piece created with no
  // usable dimensions, and because "the caller validates" is how that class of
  // bug comes back. The assertion is safe by construction: DEFAULT_ASPECT_RATIO_ID
  // is itself a catalog member, pinned by a test in aspect-ratio.test.ts.
  const dims = dimensionsFor(aspectRatioId) ?? dimensionsFor(DEFAULT_ASPECT_RATIO_ID)!;
  const manifest = { ...structuredClone(EMPTY_MANIFEST), ...dims };

  try {
    await saveManifest(pieceId, manifest);
    await saveCurrentSnapshot(pieceId, manifest);
  } catch (err) {
    logger.error(
      {
        tag: "pieces",
        op: "create_manifest_failed",
        pieceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to write manifest/snapshot for new piece; piece row already committed, continuing without it",
    );
  }
}
