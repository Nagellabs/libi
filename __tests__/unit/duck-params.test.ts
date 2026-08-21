import { describe, it, expect } from "vitest";
import { DEFAULT_DUCK, duckSidechainIds, sanitizeDuck, validateDuck } from "@/lib/audio/duck-params";

describe("duck-params", () => {
  it("DEFAULT_DUCK is musically sensible (-30 dB threshold, 4:1 ratio, 50ms attack, 250ms release)", () => {
    expect(DEFAULT_DUCK).toEqual({
      sidechainClipIds: [],
      thresholdDb: -30,
      ratio: 4,
      attackMs: 50,
      releaseMs: 250,
      reductionDb: -12,
    });
  });

  it("sanitizeDuck clamps numeric ranges", () => {
    expect(sanitizeDuck({
      sidechainClipIds: ["x"],
      thresholdDb: -100,    // < -60 floor
      ratio: 0.5,           // < 1 floor
      attackMs: -5,         // < 1 floor
      releaseMs: 99999,     // > 5000 ceiling
      reductionDb: 5,       // positive — clamp to 0 max
    })).toEqual({
      sidechainClipIds: ["x"],
      thresholdDb: -60,
      ratio: 1,
      attackMs: 1,
      releaseMs: 5000,
      reductionDb: 0,
    });
  });

  it("validateDuck rejects an empty sidechain list", () => {
    expect(validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: [] }, []).ok).toBe(false);
    expect(validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["abc"] }, [{ id: "abc", duck: undefined }]).ok).toBe(true);
  });

  it("validateDuck detects a direct cycle (A ducks B, B ducks A)", () => {
    // A's duck targets B; B's duck targets A — proposing A→B closes a cycle.
    const clips = [
      { id: "A", duck: { sidechainClipIds: ["B"] } },
      { id: "B", duck: { sidechainClipIds: ["A"] } },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipIds: ["B"] },
      clips,
      "A",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  it("validateDuck detects a transitive cycle (A→B→C→A)", () => {
    const clips = [
      { id: "A", duck: undefined },
      { id: "B", duck: { sidechainClipIds: ["C"] } },
      { id: "C", duck: { sidechainClipIds: ["A"] } },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipIds: ["B"] },
      clips,
      "A",
    );
    expect(result.ok).toBe(false);
  });

  it("validateDuck allows non-cyclic chains (A→B→C, no return edge)", () => {
    const clips = [
      { id: "A", duck: undefined },
      { id: "B", duck: { sidechainClipIds: ["C"] } },
      { id: "C", duck: undefined },
    ];
    const result = validateDuck(
      { ...DEFAULT_DUCK, sidechainClipIds: ["B"] },
      clips,
      "A",
    );
    expect(result.ok).toBe(true);
  });
});

/**
 * Multiple sidechains. Before 2026-08-18 a duck had exactly ONE sidechain, so a
 * piece with six voice-over lines had to be ffmpeg'd into a single "VO bus"
 * clip and re-rendered on every retime. `sanitizeDuck` is the one read-time
 * seam that turns the legacy spelling into the array — there is no migration
 * script, so a regression here breaks every piece already on disk.
 */
describe("multiple sidechains", () => {
  it("normalizes a legacy single sidechainClipId to an array", () => {
    const d = sanitizeDuck({
      sidechainClipId: "clip_a",
      thresholdDb: -30,
      ratio: 4,
      attackMs: 50,
      releaseMs: 250,
      reductionDb: -12,
    });
    expect(d.sidechainClipIds).toEqual(["clip_a"]);
    expect("sidechainClipId" in d).toBe(false);
  });

  it("keeps every id when several are given", () => {
    const d = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["a", "b", "c"] });
    expect(d.sidechainClipIds).toEqual(["a", "b", "c"]);
  });

  it("drops empty ids and duplicates, preserving order", () => {
    const d = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["b", "", "a", "b"] });
    expect(d.sidechainClipIds).toEqual(["b", "a"]);
  });

  it("prefers the array when a legacy id is also present", () => {
    const d = sanitizeDuck({
      ...DEFAULT_DUCK,
      sidechainClipIds: ["new"],
      sidechainClipId: "old",
    } as Parameters<typeof sanitizeDuck>[0]);
    expect(d.sidechainClipIds).toEqual(["new"]);
  });

  it("duckSidechainIds reads either spelling", () => {
    expect(duckSidechainIds({ sidechainClipIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(duckSidechainIds({ sidechainClipId: "legacy" })).toEqual(["legacy"]);
    expect(duckSidechainIds({})).toEqual([]);
  });

  it("validateDuck rejects when ANY sidechain is missing", () => {
    const clips = [{ id: "a", duck: undefined }];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["a", "ghost"] }, clips, "music");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
  });

  it("validateDuck rejects a self-duck hidden among several sidechains", () => {
    const clips = [{ id: "a", duck: undefined }, { id: "music", duck: undefined }];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["a", "music"] }, clips, "music");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/itself/i);
  });

  it("validateDuck accepts several valid sidechains", () => {
    const clips = [
      { id: "vo1", duck: undefined },
      { id: "vo2", duck: undefined },
      { id: "vo3", duck: undefined },
    ];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo1", "vo2", "vo3"] }, clips, "music");
    expect(r.ok).toBe(true);
  });

  it("validateDuck finds a cycle reachable through the SECOND sidechain", () => {
    // music ducks [vo1, bed]; bed ducks music. Only the second edge closes it.
    const clips = [
      { id: "vo1", duck: undefined },
      { id: "bed", duck: { sidechainClipIds: ["music"] } },
    ];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo1", "bed"] }, clips, "music");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it("validateDuck follows every out-edge when walking for cycles (branching graph)", () => {
    // music → a ; a → [x, y] ; y → music. Following only the first successor
    // of `a` would miss this.
    const clips = [
      { id: "a", duck: { sidechainClipIds: ["x", "y"] } },
      { id: "x", duck: undefined },
      { id: "y", duck: { sidechainClipIds: ["music"] } },
    ];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["a"] }, clips, "music");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it("validateDuck still reads a legacy duck edge when walking the graph", () => {
    const clips = [{ id: "bed", duck: { sidechainClipId: "music" } }];
    const r = validateDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["bed"] }, clips, "music");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });
});
