import { describe, it, expect } from "vitest";
import {
  prepareOverlayTracks,
  prepareTrackForRender,
  trackedSizePolicyByTrack,
  DEFAULT_MAX_BOX_SCALE,
} from "@/lib/tracking/prepare-overlay-tracks";
import { mergeAnchorOverridesIntoTrack } from "@/lib/tracking/manual-anchors";
import {
  stabilizeTrackSize,
  resizeAnchorFromOffset,
} from "@/lib/tracking/size-stabilize";
import { stabilizeTrackPosition } from "@/lib/tracking/position-stabilize";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track, TrackSample } from "@/lib/tracking/types";
import type { Overlay } from "@/lib/engine/types";

// Engine samples: steady 78x52 head box at x=180, EXCEPT one size spike at
// t=0.5 (w=300) that size-stabilization must clamp.
const samples = Array.from({ length: 60 }, (_, i) => {
  const t = i / 30;
  const spike = i === 15; // t = 0.5
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

function trk(extra: Partial<Track> = {}): Track {
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
    // UNCONSUMED manual pin at t=1.0 (no provenance:"manual" segment exists)
    // → the render override must stamp it, and the position pass must SNAP
    // to it (pin times reset the One-Euro filter).
    manualAnchors: [
      { id: "man-1000", time: 1.0, bbox: [300, 255, 78, 52], createdAt: 1 },
    ],
    ...extra,
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

function meanAbsDeltaCy(ss: TrackSample[]): number {
  const vis = ss.filter((s) => s.visible);
  let sum = 0;
  for (let i = 1; i < vis.length; i++) {
    sum += Math.abs(vis[i].y + vis[i].h / 2 - (vis[i - 1].y + vis[i - 1].h / 2));
  }
  return sum / (vis.length - 1);
}

describe("prepareOverlayTracks — the ONE track-hydration seam", () => {
  it("matches the three-transform composition exactly (merge → size → position)", () => {
    const prepared = prepareOverlayTracks({ "trk-1": trk() }, [trackedOverlay()]);
    const reference = stabilizeTrackPosition(
      stabilizeTrackSize(mergeAnchorOverridesIntoTrack(trk()), {
        mode: "stabilized",
        maxBoxScale: DEFAULT_MAX_BOX_SCALE,
      }),
      { mode: "stabilized" },
    );
    expect(prepared["trk-1"]).toEqual(reference);
    // prepareTrackForRender IS that composition (verify-render delegates to it).
    expect(prepareTrackForRender(trk(), {})).toEqual(reference);
  });

  it("stamps the manual pin (raw engine samples alone would render elsewhere)", () => {
    const raw = trk();
    const prepared = prepareOverlayTracks({ "trk-1": raw }, [trackedOverlay()]);
    const at = sampleTrack(prepared["trk-1"], 1.0, "linear")!;
    expect(at.x).toBe(300); // the pin, not the engine's x=180 — position pass SNAPS
    // This is the divergence the export path used to ship:
    expect(sampleTrack(trk(), 1.0, "linear")!.x).toBe(180);
  });

  it("clamps the size spike under the default stabilized policy", () => {
    const prepared = prepareOverlayTracks({ "trk-1": trk() }, [trackedOverlay()]);
    const spike = prepared["trk-1"].samples.find(
      (s) => Math.abs(s.t - 0.5) < 1e-6,
    )!;
    expect(spike.w).toBeLessThanOrEqual(78 * DEFAULT_MAX_BOX_SCALE + 1e-6);
  });

  it("damps per-frame center jitter by default (the bounce fix)", () => {
    const jittery = trk({ manualAnchors: [] });
    jittery.samples = jittery.samples.map((s, i) => ({
      ...s,
      y: s.y + (i % 2 === 0 ? 6 : -6),
    }));
    jittery.segments![0].samples = jittery.samples;
    const prepared = prepareOverlayTracks({ "trk-1": jittery }, [trackedOverlay()]);
    expect(meanAbsDeltaCy(prepared["trk-1"].samples)).toBeLessThan(
      0.3 * meanAbsDeltaCy(jittery.samples),
    );
  });

  it("honors positionMode:'raw' (jitter passes through verbatim)", () => {
    const jittery = trk({ manualAnchors: [] });
    jittery.samples = jittery.samples.map((s, i) => ({
      ...s,
      y: s.y + (i % 2 === 0 ? 6 : -6),
    }));
    jittery.segments![0].samples = jittery.samples;
    const prepared = prepareOverlayTracks({ "trk-1": jittery }, [
      trackedOverlay({ positionMode: "raw" }),
    ]);
    // Size clamp only reshapes the w-spike (center preserved) — cy jitter is intact.
    expect(meanAbsDeltaCy(prepared["trk-1"].samples)).toBeCloseTo(
      meanAbsDeltaCy(jittery.samples),
      8,
    );
  });

  it("honors a per-overlay sizeMode:'raw' policy (spike preserved, anchors still merged)", () => {
    const prepared = prepareOverlayTracks({ "trk-1": trk() }, [
      trackedOverlay({ sizeMode: "raw" }),
    ]);
    const spike = prepared["trk-1"].samples.find(
      (s) => Math.abs(s.t - 0.5) < 1e-6,
    )!;
    expect(spike.w).toBe(300);
    expect(sampleTrack(prepared["trk-1"], 1.0, "linear")!.x).toBe(300);
  });

  it("derives last-wins policy per trackId from tracked overlays only", () => {
    const policy = trackedSizePolicyByTrack([
      trackedOverlay({ sizeMode: "raw", positionMode: "raw" }),
      trackedOverlay({ id: "ov-2", sizeMode: "stabilized", maxBoxScale: 3 }),
    ]);
    expect(policy["trk-1"]).toEqual({
      sizeMode: "stabilized",
      maxBoxScale: 3,
      resizeAnchor: { x: "center", y: "center" },
    });
    expect(
      trackedSizePolicyByTrack([trackedOverlay({ positionMode: "raw" })])["trk-1"]
        .positionMode,
    ).toBe("raw");
  });
});

// Flap fixture (see size-stabilize tests): TOP edge steady at y=100, height
// flapping 90↔184 every 4th frame — the residual-bounce root cause.
function flapTrk(): Track {
  const flapSamples = Array.from({ length: 41 }, (_, i) => ({
    t: i / 30, x: 200, y: 100, w: 80,
    h: i % 4 === 3 ? 184 : 90,
    confidence: 1, visible: true,
  }));
  return {
    id: "trk-flap", fileId: "f", label: "s", method: "yoloe+botsort",
    framerate: 30, durationSec: 41 / 30,
    samples: flapSamples, segments: [], anchors: [],
  } as unknown as Track;
}

describe("resize-anchor policy derivation (lever 2 wiring)", () => {
  it("trackedSizePolicyByTrack derives the anchor from the overlay offset", () => {
    const policy = trackedSizePolicyByTrack([
      trackedOverlay({ offset: { x: 0, y: -0.5 } } as never),
    ]);
    expect(policy["trk-1"].resizeAnchor).toEqual({ x: "center", y: "top" });
    const noOff = trackedSizePolicyByTrack([trackedOverlay()]);
    expect(noOff["trk-1"].resizeAnchor).toEqual({ x: "center", y: "center" });
  });

  it("end-to-end: an above-offset overlay gets a rock-still top edge through the FULL seam", () => {
    const prepared = prepareTrackForRender(flapTrk(), {
      resizeAnchor: resizeAnchorFromOffset({ x: 0, y: -0.5 }),
    });
    // Size pass holds y=100 and medians h to 90 → center constant 145 →
    // the One-Euro position pass passes a constant through BIT-EXACTLY.
    for (const s of prepared.samples) {
      expect(s.y).toBe(100);
      expect(s.h).toBe(90);
    }
  });

  it("end-to-end default (no offset): size smoothed, center behavior unchanged", () => {
    const prepared = prepareTrackForRender(flapTrk(), {});
    expect(prepared.samples.every((s) => s.h === 90)).toBe(true);
    expect(prepared.samples.some((s) => s.y !== 100)).toBe(true); // bounce not top-held
  });
});

describe("preview hook delegation (no drift possible)", () => {
  it("the hook module re-exports the shared implementations by reference", async () => {
    const hook = await import("@/hooks/preview/use-overlay-tracks");
    const shared = await import("@/lib/tracking/prepare-overlay-tracks");
    expect(hook.applyManualAnchorsToTrackMap).toBe(shared.applyManualAnchorsToTrackMap);
    expect(hook.applyOverlaySizeStabilization).toBe(shared.applyOverlaySizeStabilization);
    expect(hook.applyOverlayPositionStabilization).toBe(
      shared.applyOverlayPositionStabilization,
    );
    expect(hook.DEFAULT_MAX_BOX_SCALE).toBe(shared.DEFAULT_MAX_BOX_SCALE);
  });
});
