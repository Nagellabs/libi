// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClipGainOverlay } from "@/components/preview/clip-gain-overlay";
import { clipGainView, VIEW_DB_MAX, VIEW_DB_MIN } from "@/lib/audio/clip-gain-view";

const clip = (over: Record<string, unknown> = {}) => ({ duration: 20, ...over }) as Parameters<typeof clipGainView>[0];

describe("clipGainView", () => {
  it("draws nothing for a clip with no gain, envelope or crossfade", () => {
    expect(clipGainView(clip())).toBeNull();
    expect(clipGainView(clip({ gainDb: 0 }))).toBeNull();
  });

  it("is a flat line at the gain when there is no envelope", () => {
    const v = clipGainView(clip({ gainDb: 3 }))!;
    const ys = new Set(v.points.split(" ").map((p) => p.split(",")[1]));
    expect(ys.size).toBe(1);
    expect(v.keys).toEqual([]);
    expect(v.label).toBe("+3 dB");
    // +3 dB sits above the 0 dB reference (smaller y = higher)
    expect(Number([...ys][0])).toBeLessThan(v.zeroY);
  });

  it("follows the envelope: a dip is lower than the plateau around it, with a diamond per key", () => {
    const v = clipGainView(
      clip({ gainDb: 4, volumeKeyframes: { keyframes: [{ t: 4, value: 0 }, { t: 6, value: -12 }, { t: 12, value: -12 }, { t: 14, value: 0 }] } }),
    )!;
    const pts = v.points.split(" ").map((p) => p.split(",").map(Number));
    const at = (pct: number) => pts.find(([x]) => Math.abs(x - pct) < 0.6)![1];
    expect(at(45)).toBeGreaterThan(at(10)); // 9 s is in the dip, 2 s is not
    expect(v.keys).toHaveLength(4);
    expect(v.keys[1].x).toBe(30);
    expect(v.label).toBe("+4 dB · 4 keys");
  });

  it("keeps the line inside the box however extreme the key", () => {
    const v = clipGainView(clip({ gainDb: 12, volumeKeyframes: { keyframes: [{ t: 0, value: 12 }, { t: 10, value: -60 }] } }))!;
    for (const p of v.points.split(" ")) {
      const y = Number(p.split(",")[1]);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
    expect(VIEW_DB_MIN).toBeLessThan(0);
    expect(VIEW_DB_MAX).toBeGreaterThan(0);
  });

  it("names a crossfade", () => {
    expect(clipGainView(clip({ crossfadeMs: 80 }))!.label).toBe("xfade 80 ms");
  });
});

describe("ClipGainOverlay", () => {
  it("renders the envelope over a clip that has one, and nothing over a plain clip", () => {
    const { container, rerender } = render(<ClipGainOverlay clip={clip()} />);
    expect(container.firstChild).toBeNull();
    rerender(<ClipGainOverlay clip={clip({ gainDb: -6, volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 5, value: -9 }] } })} />);
    const box = screen.getByTestId("clip-gain-envelope");
    expect(box.getAttribute("title")).toBe("-6 dB · 2 keys");
    expect(box.querySelector("polyline")).not.toBeNull();
    // it never intercepts the clip's own drag/click
    expect(box.className).toContain("pointer-events-none");
  });
});
