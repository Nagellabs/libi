import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { Track, TrackSample } from "@/lib/tracking/types";

describe("summarizeTrack no_output", () => {
  it("flags an entirely empty track (total:0) — the portrait engine-miss bug", () => {
    const track = { samples: [], segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 21.267 });
    expect(sum.total).toBe(0);
    expect(sum.flags).toContain("no_output");
    expect(sum.issues.some((i) => i.kind === "no_output")).toBe(true);
  });

  it("flags a track with samples but ZERO visible (all-lost) as no_output, not low_visibility", () => {
    const samples: TrackSample[] = Array.from({ length: 43 }, (_, i) => ({
      t: i / 30, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false,
    }));
    const track = { samples, segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 21.267 });
    expect(sum.flags).toContain("no_output");
    expect(sum.flags).not.toContain("low_visibility");
  });

  it("does NOT flag no_output on a partially-visible track (still low_visibility)", () => {
    const samples: TrackSample[] = Array.from({ length: 1152 }, (_, i) => {
      const t = i / 30;
      const visible = t < 4.2; // 127 visible — the original low_visibility case
      return visible
        ? { t, x: 100, y: 100, w: 80, h: 80, confidence: 0.9, visible: true }
        : { t, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false };
    });
    const track = { samples, segments: [], method: "yoloe+botsort" } as unknown as Track;
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 38.545 });
    expect(sum.flags).not.toContain("no_output");
    expect(sum.flags).toContain("low_visibility");
  });
});
