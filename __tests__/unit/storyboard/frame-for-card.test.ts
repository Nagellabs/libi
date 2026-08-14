import { describe, it, expect } from "vitest";
import { parseAspectRatio, frameForCard } from "@/lib/storyboard/render-card";
import type { StoryboardCard, GenSpec } from "@/lib/storyboard/types";

/** Minimal card with optional generation specs; the renderer only reads
 *  clipGen/keyframeGen params.aspect_ratio to size the schematic frame. */
function card(opts: { clip?: string; keyframe?: string }): StoryboardCard {
  const gen = (ar: string): GenSpec => ({ apiUrl: "u", model: "m", params: { aspect_ratio: ar } });
  return {
    id: "c1", order: 0, durationSec: 6, role: "hook", kind: "ai-video", title: "t",
    sketches: [], camera: { shot: "wide" }, promptFragment: "p", stage: "schematic", approvals: {},
    ...(opts.clip ? { clipGen: gen(opts.clip) } : {}),
    ...(opts.keyframe ? { keyframeGen: gen(opts.keyframe) } : {}),
  } as StoryboardCard;
}

describe("parseAspectRatio", () => {
  it("parses W:H, WxH, and W/H forms", () => {
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9, 5);
    expect(parseAspectRatio("1280x720")).toBeCloseTo(16 / 9, 5);
    expect(parseAspectRatio("4/3")).toBeCloseTo(4 / 3, 5);
    expect(parseAspectRatio("1:1")).toBe(1);
  });
  it("returns null for unparseable / non-string / zero values", () => {
    expect(parseAspectRatio(undefined)).toBeNull();
    expect(parseAspectRatio("landscape")).toBeNull();
    expect(parseAspectRatio("")).toBeNull();
    expect(parseAspectRatio("0:5")).toBeNull();
    expect(parseAspectRatio(169 as unknown as string)).toBeNull();
  });
});

describe("frameForCard", () => {
  it("sizes a landscape clip to a 16:9 frame (long edge 1280)", () => {
    expect(frameForCard(card({ clip: "16:9" }))).toEqual({ width: 1280, height: 720 });
  });
  it("sizes a portrait clip to a 9:16 frame", () => {
    expect(frameForCard(card({ clip: "9:16" }))).toEqual({ width: 720, height: 1280 });
  });
  it("sizes a square clip to 1:1", () => {
    expect(frameForCard(card({ clip: "1:1" }))).toEqual({ width: 1280, height: 1280 });
  });
  it("falls back to the keyframe spec's aspect when the clip spec has none", () => {
    expect(frameForCard(card({ keyframe: "16:9" }))).toEqual({ width: 1280, height: 720 });
  });
  it("prefers the clip spec aspect over the keyframe spec", () => {
    expect(frameForCard(card({ clip: "9:16", keyframe: "16:9" }))).toEqual({ width: 720, height: 1280 });
  });
  it("defaults to 9:16 portrait when the card has no resolvable aspect yet", () => {
    expect(frameForCard(card({}))).toEqual({ width: 720, height: 1280 });
  });
});
