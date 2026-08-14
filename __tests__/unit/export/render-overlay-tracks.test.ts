import { describe, it, expect, vi } from "vitest";
import { loadOverlayTracks } from "@/lib/export/render-overlay-tracks";
import { prepareOverlayTracks } from "@/lib/tracking/prepare-overlay-tracks";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track } from "@/lib/tracking/types";
import type { Overlay } from "@/lib/engine/types";

// Same fixture family as prepare-overlay-tracks.test.ts: steady head box with
// one size spike + an UNCONSUMED manual pin at t=1.0.
const samples = Array.from({ length: 60 }, (_, i) => {
  const t = i / 30;
  const spike = i === 15;
  return {
    t,
    x: 180,
    y: 255,
    w: spike ? 300 : 78,
    h: 52,
    confidence: 1,
    visible: true,
  };
});

function trk(): Track {
  return {
    id: "trk-1",
    fileId: "f",
    label: "subject",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: 2,
    samples: samples.map((s) => ({ ...s })),
    segments: [
      {
        id: "seg-0-2000",
        startTime: 0,
        endTime: 2,
        method: "yoloe+botsort",
        status: "ok",
        samples: samples.map((s) => ({ ...s })),
      },
    ],
    anchors: [],
    manualAnchors: [
      { id: "man-1000", time: 1.0, bbox: [300, 255, 78, 52], createdAt: 1 },
    ],
  } as unknown as Track;
}

function trackedOverlay(
  extra: Partial<Extract<Overlay, { kind: "tracked" }>> = {},
): Overlay {
  return {
    id: "ov-1",
    kind: "tracked",
    trackId: "trk-1",
    startTime: 0,
    duration: 2,
    z: 1,
    rect: { x: 0, y: 0, w: 200, h: 200 },
    content: { kind: "emoji", char: "🔥" },
    fit: "tight",
    scale: 1,
    smoothing: "linear",
    ...extra,
  } as Overlay;
}

function fetchOk(track: Track): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => track,
  })) as unknown as typeof fetch;
}

describe("export loadOverlayTracks — preview-identical hydration", () => {
  it("returns tracks hydrated through prepareOverlayTracks (pins stamped, size stabilized)", async () => {
    const overlays = [trackedOverlay()];
    const out = await loadOverlayTracks(overlays, fetchOk(trk()));
    expect(out).toEqual(prepareOverlayTracks({ "trk-1": trk() }, overlays));
    // The user-visible symptom this fixes: the manual pin renders at x=300 in
    // the EXPORT exactly as it does in the preview (raw engine x was 180).
    expect(sampleTrack(out["trk-1"], 1.0, "linear")!.x).toBe(300);
  });

  it("skips a failed track fetch instead of failing the export", async () => {
    const failing = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const out = await loadOverlayTracks([trackedOverlay()], failing);
    expect(out).toEqual({});
  });

  it("dedupes trackIds across overlays (one fetch per track)", async () => {
    const impl = fetchOk(trk());
    await loadOverlayTracks(
      [trackedOverlay(), trackedOverlay({ id: "ov-2" })],
      impl,
    );
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
