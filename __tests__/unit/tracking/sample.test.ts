import { describe, it, expect } from "vitest";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track } from "@/lib/tracking/types";

function track(samples: { t: number; x: number; visible?: boolean }[]): Track {
  return {
    id: "t",
    fileId: "f",
    method: "mediapipe-face",
    framerate: 30,
    durationSec: samples[samples.length - 1].t,
    samples: samples.map((s) => ({
      t: s.t,
      x: s.x, y: 0, w: 10, h: 10,
      confidence: 1,
      visible: s.visible ?? true,
    })),
  };
}

describe("sampleTrack", () => {
  it("returns null before first sample's t", () => {
    expect(sampleTrack(track([{ t: 1, x: 0 }, { t: 2, x: 10 }]), 0.5, "linear")).toBeNull();
  });
  it("returns null after last sample's t", () => {
    expect(sampleTrack(track([{ t: 1, x: 0 }, { t: 2, x: 10 }]), 3, "linear")).toBeNull();
  });
  it("returns the exact sample at a matching t", () => {
    const r = sampleTrack(track([{ t: 1, x: 5 }, { t: 2, x: 10 }]), 1, "linear");
    expect(r?.x).toBe(5);
  });
  it("linearly interpolates between samples", () => {
    const r = sampleTrack(track([{ t: 0, x: 0 }, { t: 1, x: 10 }]), 0.5, "linear");
    expect(r?.x).toBe(5);
  });
  it("returns visible=false when both neighbors are invisible", () => {
    const r = sampleTrack(
      track([{ t: 0, x: 0, visible: false }, { t: 1, x: 10, visible: false }]),
      0.5, "linear",
    );
    expect(r?.visible).toBe(false);
  });
  it("returns visible=false when only one neighbor is visible (AND, not OR)", () => {
    // Mixed-visibility brackets mean we're crossing a detection gap; the
    // invisible end has no real position, so lerping would produce a stale
    // value. AND semantics keep the overlay hidden across the gap.
    const r = sampleTrack(
      track([{ t: 0, x: 0, visible: true }, { t: 1, x: 10, visible: false }]),
      0.5, "linear",
    );
    expect(r?.visible).toBe(false);
  });
  it("returns visible=true only when BOTH neighbors are visible", () => {
    const r = sampleTrack(
      track([{ t: 0, x: 0, visible: true }, { t: 1, x: 10, visible: true }]),
      0.5, "linear",
    );
    expect(r?.visible).toBe(true);
  });
});
