"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * The timeline keyframe gestures — add / delete / clear-all / set-easing —
 * against `/api/pieces/[id]/overlays/[overlayId]/keyframes`. That route shares
 * the keyframe core with the MCP tools and fires `refresh_query` (SSE) on
 * success, so the composition refetches on its own — no optimistic state here.
 *
 * `time` is SECONDS within the overlay clip (0..duration), matching the route.
 * Mirrors `lib/queries/clips.ts#useClipOps`.
 */
interface KeyframeOpResponse {
  success?: boolean;
  error?: string;
  version?: number;
  data?: unknown;
}

const KEYFRAMES_URL = (pieceId: string, overlayId: string) =>
  `/api/pieces/${pieceId}/overlays/${overlayId}/keyframes`;

async function parse(res: Response, fallback: string): Promise<KeyframeOpResponse> {
  const data = (await res.json().catch(() => ({}))) as KeyframeOpResponse;
  if (!res.ok || data.success === false) {
    throw new Error(data.error || fallback);
  }
  return data;
}

export function useKeyframeOps(pieceId: string) {
  // Add (or replace) a keyframe at `time` seconds. `properties`/`easing` are
  // optional; omitted ⇒ the route snapshots the current values at `time`.
  const add = useMutation({
    mutationFn: async (vars: {
      overlayId: string;
      time: number;
      properties?: Record<string, unknown>;
      easing?: string;
    }) => {
      const { overlayId, ...body } = vars;
      const res = await fetch(KEYFRAMES_URL(pieceId, overlayId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return parse(res, "Couldn't add the keyframe");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't add the keyframe"),
  });

  // Delete the keyframe at `time` seconds (across every track at that time).
  const remove = useMutation({
    mutationFn: async (vars: { overlayId: string; time: number }) => {
      const { overlayId, time } = vars;
      const res = await fetch(KEYFRAMES_URL(pieceId, overlayId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time }),
      });
      return parse(res, "Couldn't delete the keyframe");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't delete the keyframe"),
  });

  // Clear EVERY keyframe on the overlay (drop the whole `keyframes` field).
  const clear = useMutation({
    mutationFn: async (vars: { overlayId: string }) => {
      const res = await fetch(`${KEYFRAMES_URL(pieceId, vars.overlayId)}?all=1`, {
        method: "DELETE",
      });
      return parse(res, "Couldn't clear keyframes");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't clear keyframes"),
  });

  // Set the outgoing-segment easing on the keyframe at `time` seconds.
  const setEasing = useMutation({
    mutationFn: async (vars: { overlayId: string; time: number; easing: string }) => {
      const { overlayId, time, easing } = vars;
      const res = await fetch(KEYFRAMES_URL(pieceId, overlayId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time, easing }),
      });
      return parse(res, "Couldn't set easing");
    },
    onError: (err: Error) => toast.error(err.message || "Couldn't set easing"),
  });

  return { add, remove, clear, setEasing };
}
