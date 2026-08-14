"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SelectionStore } from "@/lib/preview/selection-store";

type ClipOp = "split" | "delete" | "duplicate";

interface ClipOpResponse {
  ok?: boolean;
  family?: "scene" | "overlay" | "audio";
  newId?: string;
  tailId?: string;
  error?: string;
}

async function postClipOp(
  pieceId: string,
  body: { op: ClipOp; targetId: string; atTime?: number; ripple?: boolean },
): Promise<ClipOpResponse> {
  const res = await fetch(`/api/pieces/${pieceId}/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ClipOpResponse;
  if (!res.ok) throw new Error(data.error || "clip operation failed");
  return data;
}

/**
 * The timeline right-click menu's three clip gestures — cut (split) / delete /
 * duplicate. POSTs to /api/pieces/[id]/clips, which shares the clip-ops core with
 * the MCP tools and fires refresh_query (SSE) so the composition refetches on its
 * own. After a split/duplicate the new clip is selected so the inspector follows.
 */
export function useClipOps(pieceId: string, selectionStore: SelectionStore) {
  const split = useMutation({
    mutationFn: (vars: { targetId: string; atTime: number }) =>
      postClipOp(pieceId, { op: "split", ...vars }),
    onSuccess: (data) => {
      if (data.tailId) selectionStore.set(data.tailId);
    },
    onError: (err: Error) => {
      toast.error(
        err.message === "split_out_of_bounds"
          ? "Move the playhead over the clip to cut it"
          : "Couldn't cut the clip",
      );
    },
  });

  const remove = useMutation({
    mutationFn: (vars: { targetId: string; ripple?: boolean }) =>
      postClipOp(pieceId, { op: "delete", ...vars }),
    onError: (_err, vars) =>
      toast.error(vars.ripple ? "Couldn't ripple delete the clip" : "Couldn't delete the clip"),
  });

  const duplicate = useMutation({
    mutationFn: (vars: { targetId: string }) =>
      postClipOp(pieceId, { op: "duplicate", ...vars }),
    onSuccess: (data) => {
      if (data.newId) selectionStore.set(data.newId);
    },
    onError: () => toast.error("Couldn't duplicate the clip"),
  });

  return { split, remove, duplicate };
}
