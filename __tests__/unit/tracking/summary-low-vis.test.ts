import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { Track, TrackSample } from "@/lib/tracking/types";

function mkSamples(): TrackSample[] {
  const s: TrackSample[] = [];
  for (let i = 0; i < 1152; i++) {
    const t = i / 30;
    const visible = t < 4.2; // 127 visible, the rest absent — the real bug
    s.push(visible
      ? { t, x: 100, y: 100, w: 80, h: 80, confidence: 0.9, visible: true }
      : { t, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false });
  }
  return s;
}

describe("summarizeTrack low_visibility", () => {
  it("flags a track that is absent for most of its duration", () => {
    const track = { samples: mkSamples(), segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 38.545 });
    expect(sum.flags).toContain("low_visibility");
    expect(sum.issues.some((i) => i.kind === "low_visibility")).toBe(true);
  });

  it("does NOT flag a healthy mostly-visible track", () => {
    const s: TrackSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i / 30, x: 10, y: 10, w: 50, h: 50, confidence: 0.9, visible: true,
    }));
    const track = { samples: s, segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 3.4 });
    expect(sum.flags).not.toContain("low_visibility");
  });

  it("does NOT flag a track exactly at the 0.6 threshold (65/100 visible)", () => {
    // Pins the LOW_VIS_FRACTION threshold at 0.6 — 65% visible is above it, so no flag.
    const s: TrackSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i / 30,
      x: i < 65 ? 10 : 0, y: i < 65 ? 10 : 0,
      w: i < 65 ? 50 : 0, h: i < 65 ? 50 : 0,
      confidence: i < 65 ? 0.9 : 0,
      visible: i < 65,
    }));
    const track = { samples: s, segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 100 / 30 });
    expect(sum.flags).not.toContain("low_visibility");
  });
});
