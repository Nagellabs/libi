import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { pieceKeys } from "./pieces";
import type { AudioClip } from "@/lib/engine/types";

/**
 * Add a STANDALONE audio clip (drag-audio-onto-the-timeline). POSTs to the
 * existing audio-clips route (which calls `audioAddClip`); the SSE
 * refresh_query composition drives the refetch — no optimistic insert
 * (mirrors useAddOverlay). The file must already belong to the piece (an OS
 * drop uploads it first, then passes the new fileId).
 */
export function useAddAudioClip(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      fileId: string;
      startTime: number;
      label?: string;
      duration?: number;
    }) => {
      const res = await fetch(`/api/pieces/${pieceId}/audio-clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileId: vars.fileId,
          kind: "standalone",
          startTime: vars.startTime,
          label: vars.label,
          duration: vars.duration,
        }),
      });
      if (!res.ok) throw new Error(`Add audio clip failed: ${res.status}`);
      return res.json() as Promise<{ clipId: string }>;
    },
    onError: () => toast.error("Couldn't add the audio clip"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}

interface AudioClipPatch {
  startTime?: number;
  duration?: number;
  trimStart?: number;
  volume?: number;
  enabled?: boolean;
  label?: string;
  /** Vertical placement of a DETACHED audio track in the timeline stack. */
  timelineOrder?: number;
}

/**
 * Optimistic patch for one audio clip. The server is the source of
 * truth (SSE refetch after) but the cache flips immediately so toggle /
 * volume drag feels instant. Roll back on error.
 */
export function useUpdateAudioClip(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { clipId: string; patch: AudioClipPatch }) => {
      const res = await fetch(`/api/pieces/${pieceId}/audio-clips/${vars.clipId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars.patch),
      });
      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
      return res.json();
    },
    onMutate: async (vars) => {
      // Patch the cache SYNCHRONOUSLY first (before any await) so the optimistic
      // position lands in the SAME React batch as the drag handler's
      // setDragSec(null) — otherwise the strip repaints one frame at its stale
      // persisted startTime, producing a visible jump-back-then-forward on
      // release. Only after patching do we cancel in-flight refetches.
      const prev = qc.getQueryData(pieceKeys.composition(pieceId));
      qc.setQueryData(pieceKeys.composition(pieceId), (data: unknown) => {
        if (!data || typeof data !== "object") return data;
        const d = data as { audioClips?: AudioClip[] };
        if (!d.audioClips) return data;
        return {
          ...d,
          audioClips: d.audioClips.map((c) =>
            c.id === vars.clipId ? { ...c, ...vars.patch } : c,
          ),
        };
      });
      await qc.cancelQueries({ queryKey: pieceKeys.composition(pieceId) });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(pieceKeys.composition(pieceId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}
