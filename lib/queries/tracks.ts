import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Track } from "@/lib/tracking/types";

export const trackKeys = {
  detail: (trackId: string) => ["track", trackId] as const,
  byFile: (fileId: string) => ["tracks-by-file", fileId] as const,
};

export function useTrack(trackId: string | null | undefined) {
  return useQuery({
    queryKey: trackKeys.detail(trackId ?? ""),
    enabled: !!trackId,
    queryFn: async (): Promise<Track> => {
      const r = await fetch(`/api/tracks/${trackId}`);
      if (!r.ok) throw new Error(`track fetch failed: ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * Action handlers for the tracked-inspector Anchors tab. Wraps the manual-
 * anchor REST endpoints and invalidates the track query so the corrected
 * windows repaint. Kept as ONE hook so the inspector coverage test can mock
 * all React Query usage of the tab in a single module mock.
 */
export function useTrackAnchorActions(
  pieceId: string | null | undefined,
  trackId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const applyDeletes = async (anchorIds: string[]) => {
    if (!pieceId || !trackId || anchorIds.length === 0) return;
    await fetch(`/api/pieces/${pieceId}/tracks/${trackId}/manual-anchors/apply-deletes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorIds }),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: trackKeys.detail(trackId) });
  };
  const retrack = async () => {
    if (!pieceId || !trackId) return;
    await fetch(`/api/pieces/${pieceId}/tracks/${trackId}/manual-anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retrack: true }),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: trackKeys.detail(trackId) });
  };
  return { applyDeletes, retrack };
}
