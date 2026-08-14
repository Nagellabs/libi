import { describe, it, expect } from "vitest";
import { renderVerifyFrames } from "@/lib/tracking/verify-render";
import { prepareTrackForRender } from "@/lib/tracking/prepare-overlay-tracks";
import { stabilizeTrackSize } from "@/lib/tracking/size-stabilize";
import type { Track } from "@/lib/tracking/types";

const base = Array.from({ length: 30 }, (_, i) => ({
  t: i / 30,
  x: 100,
  y: 100,
  w: 80,
  h: 60,
  confidence: 1,
  visible: true,
}));
const track = {
  id: "t",
  fileId: "f",
  label: "x",
  method: "m",
  framerate: 30,
  durationSec: 1,
  samples: base.map((o) => ({ ...o })),
  segments: [],
  anchors: [],
  agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [0, 0, 400, 300] }],
} as unknown as Track;

const fakePng = async () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
    "base64",
  );

describe("faithful verify-render", () => {
  it("prepared track (merge+stabilize) yields a non-ballooned anchor box + isAnchorFrame", async () => {
    // The route's exact composition: the ONE seam (merge → size → position).
    const prepared = prepareTrackForRender(track, {
      sizeMode: "stabilized",
      maxBoxScale: 1.75,
      positionMode: "stabilized",
    });
    const { frames } = await renderVerifyFrames(
      {
        track: prepared,
        srcPath: "x.mp4",
        frameW: 343,
        frameH: 382,
        times: [0.5],
        content: { kind: "emoji", char: "x" } as never,
        fit: "tight",
        scale: 1,
        smoothing: "linear",
        manualAnchorTimes: [],
        agentAnchorTimes: [0.5],
      },
      { extractFrame: fakePng },
    );
    const f = frames[0];
    expect(f.trackBbox!.w).toBeLessThanOrEqual(80 * 1.75 + 1e-6);
    expect(f.isAnchorFrame).toBe(true);
  });

  it("stabilize layer is load-bearing on a non-anchor engine spike", async () => {
    // A raw detector size spike at t=0.4 (not an anchor). Stabilized mode
    // clamps it; raw mode renders it ballooned — proving verify reflects the
    // chosen policy faithfully.
    const spikeTrack = {
      ...track,
      agentAnchors: [],
      samples: base.map((o, i) =>
        i === 12 ? { ...o, x: 0, y: 0, w: 400, h: 300 } : { ...o },
      ),
    } as unknown as Track;
    const opts = {
      srcPath: "x.mp4", frameW: 343, frameH: 382, times: [12 / 30],
      content: { kind: "emoji", char: "x" } as never,
      fit: "tight" as const, scale: 1, smoothing: "linear" as const,
      manualAnchorTimes: [], agentAnchorTimes: [],
    };
    const stab = await renderVerifyFrames(
      { ...opts, track: stabilizeTrackSize(spikeTrack, { mode: "stabilized", maxBoxScale: 1.75 }) },
      { extractFrame: fakePng },
    );
    const raw = await renderVerifyFrames(
      { ...opts, track: stabilizeTrackSize(spikeTrack, { mode: "raw", maxBoxScale: 1.75 }) },
      { extractFrame: fakePng },
    );
    expect(stab.frames[0].trackBbox!.w).toBeLessThanOrEqual(80 * 1.75 + 1e-6);
    expect(raw.frames[0].trackBbox!.w).toBe(400);
  });
});
