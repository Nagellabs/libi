"use client";

import { useQueries } from "@tanstack/react-query";
import { trackKeys } from "@/lib/queries/tracks";
import type { Track } from "@/lib/tracking/types";
import type { Overlay } from "@/lib/engine/types";
import { prepareOverlayTracks } from "@/lib/tracking/prepare-overlay-tracks";

// Re-exported so existing consumers/tests keep one import path. The
// implementations live in the shared (non-hook) seam module used by BOTH
// preview and export — see lib/tracking/prepare-overlay-tracks.ts.
export {
  DEFAULT_MAX_BOX_SCALE,
  applyManualAnchorsToTrackMap,
  applyOverlaySizeStabilization,
  applyOverlayPositionStabilization,
  prepareTrackForRender,
} from "@/lib/tracking/prepare-overlay-tracks";

export function useOverlayTracks(
  overlays: Overlay[] | undefined
): Record<string, Track> {
  const tracked = (overlays ?? []).filter(
    (o): o is Extract<Overlay, { kind: "tracked" }> => o.kind === "tracked"
  );
  const unique = Array.from(new Set(tracked.map((o) => o.trackId)));

  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: trackKeys.detail(id),
      queryFn: async (): Promise<Track> => {
        const r = await fetch(`/api/tracks/${id}`);
        if (!r.ok) throw new Error(`track fetch failed: ${r.status}`);
        return r.json();
      },
      staleTime: 5 * 60_000,
    })),
  });

  const out: Record<string, Track> = {};
  for (let i = 0; i < unique.length; i++) {
    const t = results[i].data;
    if (t) out[unique[i]] = t;
  }
  return prepareOverlayTracks(out, overlays ?? []);
}
