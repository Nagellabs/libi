import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";
import { prepareOverlayTracks } from "@/lib/tracking/prepare-overlay-tracks";

/**
 * Fetch Track JSON for every tracked overlay — keyed by trackId — and hydrate
 * it through `prepareOverlayTracks`, the SAME seam the preview uses
 * (manual+agent anchor overrides merged, then per-overlay size stabilization).
 * The chromium-render export therefore renders every tracked overlay EXACTLY
 * as the editor shows it — pins, agent re-anchors, sizeMode/maxBoxScale.
 *
 * Runs inside the headless render page (browser esbuild bundle): individually
 * robust — a failed fetch warns via console (the render page's logging
 * convention; pino is unavailable there) and skips that track rather than
 * failing the export. `fetchImpl` is injectable for node unit tests.
 */
export async function loadOverlayTracks(
  overlays: Overlay[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, Track>> {
  const trackIds = new Set<string>();
  for (const o of overlays) {
    if (o.kind === "tracked") trackIds.add(o.trackId);
  }
  const tasks = Array.from(trackIds).map(async (id) => {
    try {
      const r = await fetchImpl(`/api/tracks/${id}`);
      if (!r.ok) {
        console.warn("[Render] track fetch failed", {
          trackId: id,
          status: r.status,
        });
        return [id, null] as [string, Track | null];
      }
      const t = (await r.json()) as Track;
      return [id, t] as [string, Track | null];
    } catch (err) {
      console.warn("[Render] track fetch threw", {
        trackId: id,
        error: (err as Error).message,
      });
      return [id, null] as [string, Track | null];
    }
  });
  const results = await Promise.all(tasks);
  const out: Record<string, Track> = {};
  for (const [id, t] of results) {
    if (t) out[id] = t;
  }
  return prepareOverlayTracks(out, overlays);
}
