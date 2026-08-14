"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SelectionStore } from "@/lib/preview/selection-store";
import type { NewOverlayPayload } from "@/lib/overlays/new-overlay-defaults";

/**
 * Create a text/image/video overlay from the UI. POSTs the payload to the
 * create route; the route fires refresh_query (SSE) so the composition query
 * refetches on its own. On success the returned overlayId is set as the active
 * selection so the inspector immediately shows the new overlay.
 */
export function useAddOverlay(pieceId: string, selectionStore: SelectionStore) {
  return useMutation({
    mutationFn: async (payload: NewOverlayPayload): Promise<string | undefined> => {
      const res = await fetch(`/api/pieces/${pieceId}/overlays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("create failed");
      const data = (await res.json().catch(() => ({}))) as { overlayId?: string };
      return data.overlayId;
    },
    onSuccess: (overlayId) => {
      if (overlayId) selectionStore.set(overlayId);
    },
    onError: () => {
      toast.error("Couldn't add the overlay");
    },
  });
}
