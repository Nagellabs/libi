import { describe, it, expect } from "vitest";
import { activeClipsAt, effectiveVolume } from "@/lib/audio/active-clips";
import type { AudioClip } from "@/lib/engine/types";

const clip = (overrides: Partial<AudioClip> = {}): AudioClip => ({
  id: "c1",
  kind: "standalone",
  fileId: "f1",
  startTime: 0,
  duration: 10,
  trimStart: 0,
  volume: 1,
  enabled: true,
  ...overrides,
});

describe("activeClipsAt", () => {
  it("returns clips whose [startTime, startTime+duration) contains time", () => {
    const a = clip({ id: "a", startTime: 0, duration: 5 });
    const b = clip({ id: "b", startTime: 4, duration: 5 });
    const c = clip({ id: "c", startTime: 10, duration: 5 });
    expect(activeClipsAt([a, b, c], 4).map((x) => x.id)).toEqual(["a", "b"]);
    expect(activeClipsAt([a, b, c], 10).map((x) => x.id)).toEqual(["c"]);
  });
  it("excludes disabled clips", () => {
    const a = clip({ id: "a", enabled: false });
    expect(activeClipsAt([a], 1)).toEqual([]);
  });
  it("end is exclusive: clip with duration=5 starting at 0 is NOT active at 5", () => {
    const a = clip({ id: "a", startTime: 0, duration: 5 });
    expect(activeClipsAt([a], 5)).toEqual([]);
  });
});

describe("effectiveVolume", () => {
  it("multiplies clip volume by master volume", () => {
    const a = clip({ volume: 0.5 });
    expect(effectiveVolume(a, { masterVolume: 0.6, masterMuted: false })).toBeCloseTo(0.3);
  });
  it("returns 0 when master is muted", () => {
    const a = clip({ volume: 0.5 });
    expect(effectiveVolume(a, { masterVolume: 1, masterMuted: true })).toBe(0);
  });
  it("returns 0 when clip is disabled", () => {
    const a = clip({ volume: 0.5, enabled: false });
    expect(effectiveVolume(a, { masterVolume: 1, masterMuted: false })).toBe(0);
  });
});
