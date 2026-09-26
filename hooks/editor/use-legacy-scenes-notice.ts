"use client";

import { useEffect } from "react";
import { toast } from "sonner";

export function legacyScenesNoticeText(count: number): string {
  const one = count === 1;
  return (
    `This piece has ${count} canvas-scene layer${one ? "" : "s"} from libi 0.1.0/0.1.1. ` +
    `Canvas scenes are no longer supported, so ${one ? "it isn't" : "they aren't"} shown or exported, ` +
    `and ${one ? "it is" : "they are"} removed from the piece the next time it is saved.`
  );
}

/** Pieces told during this page's life — covers the gap before the server's
 *  answer says so (a refetch, or StrictMode's second effect run). */
const toldThisPage = new Set<string>();

/** Test hook: forget what this page has told. */
export function resetLegacyScenesNoticeForTests(): void {
  toldThisPage.clear();
}

/**
 * Tell the user, once per piece, that its canvas-scene layers from libi
 * 0.1.0/0.1.1 were not loaded. The canvas-scene layer was removed in 0.1.2
 * (f0e0a410) and `loadManifest` drops it; without this the layers simply
 * vanished.
 *
 * `count` and `noticed` are `legacyScenes` / `legacyScenesNoticed` from
 * GET /api/pieces/:id/composition. "Already told" lives on the SERVER, in the
 * settings row (`settings.legacyScenesNoticed`), recorded by
 * POST …/composition/legacy-scenes-notice once the toast is shown. Browser
 * storage could not hold it: the packaged app binds a new port on every launch,
 * so its origin — and its localStorage — is new each time.
 */
export function useLegacyScenesNotice(
  pieceId: string | null,
  count: number | undefined,
  noticed: boolean | undefined,
): void {
  useEffect(() => {
    if (!pieceId || !count || count <= 0 || noticed !== false) return;
    if (toldThisPage.has(pieceId)) return;
    toldThisPage.add(pieceId);
    toast.info(legacyScenesNoticeText(count), { id: `legacy-scenes-${pieceId}` });
    void fetch(`/api/pieces/${pieceId}/composition/legacy-scenes-notice`, { method: "POST" }).catch(() => {
      // Not recorded: the notice may show once more on a later launch. Harmless.
    });
  }, [pieceId, count, noticed]);
}
