"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import type { Composition, TextOverlay } from "@/lib/engine/types";

export interface UseOverlayEditingResult {
  /** The live text overlay currently being edited, or null. */
  editingOverlay: TextOverlay | null;
  /** Open the inline editor for the given overlay id. No-ops for non-text kinds. */
  startEdit: (overlayId: string) => void;
  /** PATCH the new content and close the editor. Fire-and-forget on network failure. */
  commit: (content: string) => Promise<void>;
  /** Close the editor without writing. */
  cancel: () => void;
}

/**
 * Owns the inline text-overlay editor state. Keeps `editingOverlay`
 * derived from the live composition so future overlay mutations (e.g.
 * drag handles updating the rect) flow into the editor without forcing
 * a remount.
 */
export function useOverlayEditing(
  activePieceId: string | null,
  composition: Composition | null,
): UseOverlayEditingResult {
  const queryClient = useQueryClient();
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);

  const editingOverlay = useMemo<TextOverlay | null>(() => {
    if (!editingOverlayId || !composition?.overlays) return null;
    const o = composition.overlays.find((x) => x.id === editingOverlayId);
    return o && o.kind === "text" ? o : null;
  }, [editingOverlayId, composition]);

  const commit = useCallback(
    async (content: string) => {
      const pieceId = activePieceId;
      const overlayId = editingOverlayId;
      setEditingOverlayId(null);
      if (!pieceId || !overlayId) return;
      try {
        const res = await fetch(`/api/pieces/${pieceId}/overlays/${overlayId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          // Don't invalidate on failure — a refetch would clobber the user's
          // local text with the unchanged server value. Log so the failure
          // is grep-able. Toast / retry UX is a further follow-up.
          console.error(
            `overlay.commit failed: ${res.status}`,
            await res.text().catch(() => ""),
          );
          return;
        }
      } catch (err) {
        console.error("overlay.commit network error:", err);
        return;
      }
      queryClient.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
    [editingOverlayId, activePieceId, queryClient],
  );

  const cancel = useCallback(() => {
    setEditingOverlayId(null);
  }, []);

  return {
    editingOverlay,
    startEdit: setEditingOverlayId,
    commit,
    cancel,
  };
}
