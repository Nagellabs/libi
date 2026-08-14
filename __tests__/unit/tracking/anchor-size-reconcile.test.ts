import { describe, it, expect } from "vitest";
import {
  localSizeEnvelope,
  mergeAnchorOverridesIntoTrack,
  ANCHOR_SIZE_RATIO,
} from "@/lib/tracking/manual-anchors";
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
function trk(extra: Partial<Track>): Track {
  return {
    id: "t",
    fileId: "f",
    label: "x",
    method: "m",
    framerate: 30,
    durationSec: 1,
    samples: base.map((o) => ({ ...o })),
    segments: [],
    anchors: [],
    ...extra,
  } as unknown as Track;
}

describe("anchor size reconciliation", () => {
  it("localSizeEnvelope ignores invisible/degenerate", () => {
    const e = localSizeEnvelope(base as never, 0.5, 0.5);
    expect(e).toEqual({ w: 80, h: 60 });
  });
  it("oversized agent anchor: horizontal from anchor, head SIZE+LEVEL from the engine track (supersedes Task-2 center-preservation for agent anchors)", () => {
    // base track is a confident head box {x:100,y:100,w:80,h:60} (centerX 140,
    // centerY 130). Agent anchor is a torso-centered person box far to the
    // right → DRIFT: keep the anchor's horizontal centre (260, the identity
    // correction) but take size + vertical from the engine head box — NEVER
    // the person-box torso centre (190). Size still bounded by the envelope.
    const t = trk({
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [60, 40, 400, 300] }],
    });
    const out = mergeAnchorOverridesIntoTrack(t);
    const a = out.samples.find((s) => Math.abs(s.t - 0.5) < 1e-9)!;
    expect(a.w).toBeLessThanOrEqual(80 * ANCHOR_SIZE_RATIO + 1e-6);
    expect(a.h).toBeLessThanOrEqual(60 * ANCHOR_SIZE_RATIO + 1e-6);
    expect(a.x + a.w / 2).toBeCloseTo(260, 4); // horizontal: the anchor's correction
    expect(a.y + a.h / 2).toBeCloseTo(130, 4); // vertical: the engine head LEVEL, not torso 190
    expect(a.w).toBeCloseTo(80, 4); // engine head SIZE
    expect(a.h).toBeCloseTo(60, 4);
    expect(a.visible).toBe(true);
    expect(a.confidence).toBe(1);
  });
  it("no envelope (all invisible) leaves anchor bbox unchanged", () => {
    const t = trk({
      samples: base.map((o) => ({ ...o, visible: false })),
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [60, 40, 400, 300] }],
    });
    const out = mergeAnchorOverridesIntoTrack(t);
    const a = out.samples.find((s) => Math.abs(s.t - 0.5) < 1e-9)!;
    expect([a.x, a.y, a.w, a.h]).toEqual([60, 40, 400, 300]);
  });
  it("well-formed manual anchor at sampled size is left intact", () => {
    const t = trk({
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [110, 110, 80, 60] }],
    });
    const out = mergeAnchorOverridesIntoTrack(t);
    const a = out.samples.find((s) => Math.abs(s.t - 0.5) < 1e-9)!;
    expect([a.w, a.h]).toEqual([80, 60]);
  });
});
