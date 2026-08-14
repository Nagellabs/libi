import { describe, it, expect } from "vitest";
import { DEFAULT_ONE_EURO_PARAMS, OneEuroFilter } from "@/lib/tracking/one-euro";

const FPS = 30;

function meanAbsDelta(xs: number[]): number {
  let s = 0;
  for (let i = 1; i < xs.length; i++) s += Math.abs(xs[i] - xs[i - 1]);
  return s / (xs.length - 1);
}

describe("OneEuroFilter", () => {
  it("passes a constant signal through exactly", () => {
    const f = new OneEuroFilter(DEFAULT_ONE_EURO_PARAMS);
    for (let i = 0; i < 60; i++) {
      expect(f.filter(300, i / FPS)).toBe(300);
    }
  });

  it("suppresses alternating jitter by >70% while the subject is still", () => {
    const f = new OneEuroFilter(DEFAULT_ONE_EURO_PARAMS);
    const raw: number[] = [];
    const filtered: number[] = [];
    for (let i = 0; i < 120; i++) {
      const v = 300 + (i % 2 === 0 ? 6 : -6); // ±6px @ 15Hz — tracker jitter
      raw.push(v);
      filtered.push(f.filter(v, i / FPS));
    }
    expect(meanAbsDelta(filtered)).toBeLessThan(0.3 * meanAbsDelta(raw));
  });

  it("tracks fast motion with bounded lag (no arrow-drags-behind failure)", () => {
    const f = new OneEuroFilter(DEFAULT_ONE_EURO_PARAMS);
    const SPEED = 600; // px/s — a fast pan
    let worstLate = 0;
    for (let i = 0; i < 90; i++) {
      const t = i / FPS;
      const v = SPEED * t;
      const out = f.filter(v, t);
      if (t > 0.5) worstLate = Math.max(worstLate, Math.abs(out - v));
    }
    expect(worstLate).toBeLessThan(30);
  });

  it("reset() makes the next sample pass through exactly", () => {
    const f = new OneEuroFilter(DEFAULT_ONE_EURO_PARAMS);
    f.filter(0, 0);
    f.filter(100, 1 / FPS);
    f.reset();
    expect(f.filter(500, 2 / FPS)).toBe(500);
  });

  it("holds the previous output on a non-advancing timestamp", () => {
    const f = new OneEuroFilter(DEFAULT_ONE_EURO_PARAMS);
    f.filter(10, 0);
    const a = f.filter(20, 1 / FPS);
    expect(f.filter(999, 1 / FPS)).toBe(a); // duplicate t: hold, never divide by 0
  });
});
