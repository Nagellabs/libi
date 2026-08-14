import { describe, it, expect } from "vitest";
import { PlaybackClock } from "@/lib/preview/playback-clock";

function makeClock() {
  let now = 100; // ctx.currentTime baseline (seconds)
  const clock = new PlaybackClock(() => now);
  return { clock, advance: (s: number) => { now += s; } };
}

describe("PlaybackClock", () => {
  it("is 0 before play", () => {
    const { clock } = makeClock();
    expect(clock.getCompositionTime()).toBe(0);
  });
  it("advances 1:1 with context time at speed 1", () => {
    const { clock, advance } = makeClock();
    clock.play();
    advance(2);
    expect(clock.getCompositionTime()).toBeCloseTo(2, 5);
  });
  it("scales by speed", () => {
    const { clock, advance } = makeClock();
    clock.setSpeed(2);
    clock.play();
    advance(1.5);
    expect(clock.getCompositionTime()).toBeCloseTo(3, 5);
  });
  it("holds time across pause/resume", () => {
    const { clock, advance } = makeClock();
    clock.play(); advance(2); clock.pause();
    advance(5);
    expect(clock.getCompositionTime()).toBeCloseTo(2, 5);
    clock.play(); advance(1);
    expect(clock.getCompositionTime()).toBeCloseTo(3, 5);
  });
  it("seek sets composition time directly", () => {
    const { clock, advance } = makeClock();
    clock.play(); clock.seek(10); advance(1);
    expect(clock.getCompositionTime()).toBeCloseTo(11, 5);
  });
});
