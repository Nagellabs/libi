import { describe, it, expect } from "vitest";
import {
  computeVideoPriorities,
  pickDominant,
  type PriorityTrack,
} from "@/lib/preview/track-priority";

const track = (id: string, o: Partial<PriorityTrack> = {}): PriorityTrack => ({
  id,
  areaFraction: o.areaFraction ?? 1,
  z: o.z ?? 0,
  opacity: o.opacity ?? 1,
  durationSec: o.durationSec ?? 5,
});

describe("computeVideoPriorities", () => {
  it("empty set → empty map, no dominant", () => {
    const scores = computeVideoPriorities([]);
    expect(scores.size).toBe(0);
    expect(pickDominant(scores)).toBeNull();
  });

  it("a big full-frame video outranks a small PIP", () => {
    const scores = computeVideoPriorities([
      track("big", { areaFraction: 1, z: 0 }),
      track("pip", { areaFraction: 0.05, z: 1 }), // small even though more in front
    ]);
    expect(scores.get("big")!).toBeGreaterThan(scores.get("pip")!);
    expect(pickDominant(scores)).toBe("big");
  });

  it("among equal-size clips, the one more in FRONT (higher z) wins", () => {
    const scores = computeVideoPriorities([
      track("back", { areaFraction: 0.5, z: 0 }),
      track("front", { areaFraction: 0.5, z: 10 }),
    ]);
    expect(scores.get("front")!).toBeGreaterThan(scores.get("back")!);
    expect(pickDominant(scores)).toBe("front");
  });

  it("among equal size + z, the LONGER on-screen clip wins", () => {
    const scores = computeVideoPriorities([
      track("brief", { areaFraction: 0.5, z: 0, durationSec: 1 }),
      track("long", { areaFraction: 0.5, z: 0, durationSec: 10 }),
    ]);
    expect(scores.get("long")!).toBeGreaterThan(scores.get("brief")!);
  });

  it("opacity scales the score down (a near-transparent video is low priority)", () => {
    const scores = computeVideoPriorities([
      track("solid", { areaFraction: 0.5, opacity: 1 }),
      track("ghost", { areaFraction: 0.5, opacity: 0.1 }),
    ]);
    expect(scores.get("ghost")!).toBeLessThan(scores.get("solid")!);
  });

  it("a single active clip is its own dominant with a nonzero score", () => {
    const scores = computeVideoPriorities([track("only", { areaFraction: 0.3 })]);
    expect(pickDominant(scores)).toBe("only");
    expect(scores.get("only")!).toBeGreaterThan(0);
  });

  it("non-finite inputs (undefined/NaN opacity or area) never produce a NaN score", () => {
    // Loosely-typed persisted overlays can arrive with opacity === undefined at
    // runtime (despite the `number` type). A NaN score silently loses every
    // comparison downstream and would leave the gate with no dominant.
    const scores = computeVideoPriorities([
      track("a", { opacity: NaN, areaFraction: NaN }),
      track("b", { opacity: undefined as unknown as number, areaFraction: 0.5 }),
    ]);
    for (const s of scores.values()) expect(Number.isFinite(s)).toBe(true);
    // Absent opacity is treated as fully opaque, so b (real area) still ranks.
    expect(pickDominant(scores)).not.toBeNull();
  });

  it("dominant tie broken deterministically by id", () => {
    const scores = computeVideoPriorities([
      track("b", { areaFraction: 1, z: 0 }),
      track("a", { areaFraction: 1, z: 0 }),
    ]);
    expect(pickDominant(scores)).toBe("a"); // identical scores → lowest id
  });
});
