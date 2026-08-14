import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track, TrackSample } from "@/lib/tracking/types";

// Frame matches the live Lisa clip.
const W = 360;
const H = 640;

function mk(samples: TrackSample[]): Track {
  return normalizeTrack({
    id: "trk",
    fileId: "f",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: samples[samples.length - 1].t + 0.05,
    samples,
  });
}

function sum(t: Track) {
  return summarizeTrack(t, { frameW: W, frameH: H, clipDurationSec: 40 });
}

describe("summarizeTrack — quality flags (generalized mistake detection)", () => {
  it("a genuinely clean centred track has NO quality flags/issues", () => {
    const samples: TrackSample[] = [];
    for (let i = 0; i < 60; i++) {
      samples.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true });
    }
    const s = sum(mk(samples));
    expect(s.flags).toEqual([]);
    expect(s.issues).toEqual([]);
  });

  it("flags oversized_box_while_visible for boxes far bigger than the subject (the brief giant-emoji frames)", () => {
    // Small Lisa box, then a few frames where the detector returns a
    // near-frame-tall/wide box (t≈5 in the real clip: w=309,h=405).
    const samples: TrackSample[] = [];
    for (let i = 0; i < 20; i++) samples.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true });
    for (let i = 20; i < 30; i++) samples.push({ t: i / 30, x: 25, y: 110, w: 309, h: 405, confidence: 0.9, visible: true });
    for (let i = 30; i < 50; i++) samples.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true });
    const s = sum(mk(samples));
    expect(s.flags).toContain("oversized_box_while_visible");
    const iss = s.issues.find((x) => x.kind === "oversized_box_while_visible");
    expect(iss?.range).toBeDefined();
    expect(iss!.range!.start).toBeGreaterThanOrEqual(20 / 30 - 0.001);
    expect(iss!.range!.end).toBeLessThanOrEqual(29 / 30 + 0.05);
  });

  it("flags identity_switch_suspected when the box teleports to a disjoint region and stays", () => {
    // Centred on Lisa for ~0.7s, then jumps to the left edge (cameraman)
    // and stays there — the real t≈22→38 failure.
    const samples: TrackSample[] = [];
    for (let i = 0; i < 22; i++) samples.push({ t: i / 30, x: 150, y: 180, w: 100, h: 260, confidence: 0.9, visible: true });
    for (let i = 22; i < 80; i++) samples.push({ t: i / 30, x: 0, y: 110, w: 70, h: 470, confidence: 0.9, visible: true });
    const s = sum(mk(samples));
    expect(s.flags).toContain("identity_switch_suspected");
    const iss = s.issues.find((x) => x.kind === "identity_switch_suspected");
    expect(iss?.range).toBeDefined();
    // The switch happens around t≈22/30 ≈ 0.73s.
    expect(iss!.range!.start).toBeGreaterThan(0.5);
    expect(iss!.range!.start).toBeLessThan(1.0);
  });

  it("flags edge_pinned for a long run hugging a frame edge (background person / cameraman)", () => {
    const samples: TrackSample[] = [];
    // 4 seconds pinned to x≈0, tall+narrow — classic wrong-subject latch.
    for (let i = 0; i < 120; i++) samples.push({ t: i / 30, x: 1, y: 110, w: 70, h: 470, confidence: 0.9, visible: true });
    const s = sum(mk(samples));
    expect(s.flags).toContain("edge_pinned");
    const iss = s.issues.find((x) => x.kind === "edge_pinned");
    expect(iss?.range).toBeDefined();
  });

  it("keeps the legacy full_canvas_while_visible flag and back-compat shape", () => {
    const s = sum(
      mk([
        { t: 0, x: 0, y: 0, w: W - 1, h: H - 1, confidence: 1, visible: true },
        { t: 1, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true },
      ]),
    );
    expect(s.flags).toContain("full_canvas_while_visible");
    expect(Array.isArray(s.issues)).toBe(true);
  });
});
