import { describe, it, expect } from "vitest";
import { diffManifests, DIFF_LINE_CAP } from "@/mcp/tools/apply-ops-diff";
import type { CompositionManifest } from "@/lib/composition/persistence";

const overlay = (over: Record<string, unknown> = {}) =>
  ({ id: "text-1", kind: "text", startTime: 0, duration: 3, rect: { x: 90, y: 1170, width: 900, height: 120 }, z: 1, opacity: 1, content: "Hi", ...over }) as never;
const clip = (over: Record<string, unknown> = {}) =>
  ({ id: "clip_a", kind: "standalone", fileId: "f", startTime: 0, duration: 8, trimStart: 0, volume: 1, enabled: true, ...over }) as never;
const m = (overlays: unknown[] = [], audioClips: unknown[] = [], extra: Record<string, unknown> = {}): CompositionManifest =>
  ({ width: 1080, height: 1920, fps: 30, overlays, audioClips, ...extra }) as never;

describe("diffManifests", () => {
  it("says nothing when nothing changed, and ignores the per-save version bump", () => {
    expect(diffManifests(m([overlay()]), m([overlay({ version: 4 })]))).toEqual([]);
  });

  it("a moved rect reads as x,y before→after, and shows the size only when the size changed", () => {
    expect(diffManifests(m([overlay()]), m([overlay({ rect: { x: 90, y: 1250, width: 900, height: 120 } })]))).toEqual([
      "overlay text-1: rect 90,1170→90,1250",
    ]);
    expect(diffManifests(m([overlay()]), m([overlay({ rect: { x: 90, y: 1170, width: 500, height: 120 } })]))).toEqual([
      "overlay text-1: rect 90,1170 900x120→90,1170 500x120",
    ]);
  });

  it("timing and trim lead the line, numbers are rounded", () => {
    const before = m([overlay({ id: "vid-1", kind: "video", trim: { start: 0, end: 8 } })]);
    const after = m([overlay({ id: "vid-1", kind: "video", duration: 11.004, startTime: 0.5, trim: { start: 0, end: 11 }, opacity: 0.5 })]);
    expect(diffManifests(before, after)).toEqual(["overlay vid-1: start 0→0.5, duration 3→11, trim 0–8→0–11, opacity 1→0.5"]);
  });

  it("added and removed overlays and clips, with their span", () => {
    const lines = diffManifests(m([overlay()], [clip()]), m([overlay({ id: "text-2", startTime: 2, duration: 4 })], [clip({ id: "clip_b", startTime: 10.38, duration: 69.1, volume: 0.4 })]));
    expect(lines).toEqual([
      'overlay text-2 added (text "Hi" 2–6)',
      "overlay text-1 removed",
      "audio clip clip_b added 10.38–79.48 vol 0.4",
      "audio clip clip_a removed",
    ]);
  });

  it("names a bound id as $name=id", () => {
    expect(diffManifests(m([], []), m([], [clip({ id: "clip_x", startTime: 10.38, duration: 69.1 })]), { music: "clip_x" })).toEqual([
      "audio clip $music=clip_x added 10.38–79.48",
    ]);
  });

  it("a duck turning on, off, or being tuned", () => {
    const duck = { sidechainClipIds: ["vo"], reductionDb: -5 };
    expect(diffManifests(m([], [clip()]), m([], [clip({ duck })]))).toEqual(["audio clip clip_a: duck on (sidechain vo; -5 dB)"]);
    expect(diffManifests(m([], [clip({ duck })]), m([], [clip()]))).toEqual(["audio clip clip_a: duck off"]);
    expect(diffManifests(m([], [clip({ duck })]), m([], [clip({ duck: { ...duck, reductionDb: -9 } })]))).toEqual([
      "audio clip clip_a: duck.reductionDb -5→-9",
    ]);
  });

  it("keyframes are counted, effects and other objects are diffed one level in", () => {
    const withKf = (n: number) => ({ keyframes: { opacity: { keyframes: Array.from({ length: n }, (_, i) => ({ t: i / 4, value: 1 })) } } });
    expect(diffManifests(m([overlay()]), m([overlay(withKf(2))]))).toEqual(["overlay text-1: keyframes none→opacity 2"]);
    expect(diffManifests(m([overlay({ effects: { in: { effectId: "fade" } } })]), m([overlay({ effects: { in: { effectId: "pop" } } })]))).toEqual([
      'overlay text-1: effects.in.effectId "fade"→"pop"',
    ]);
  });

  it("canvas, fps and other manifest-level changes", () => {
    expect(diffManifests(m(), m([], [], { width: 1920, height: 1080, fps: 24, pendingMusic: [{ x: 1 }] }))).toEqual([
      "canvas 1080x1920→1920x1080",
      "fps 30→24",
      "pendingMusic changed",
    ]);
  });

  it("caps the lines and counts the rest", () => {
    const many = Array.from({ length: DIFF_LINE_CAP + 5 }, (_, i) => overlay({ id: `o${i}` }));
    const lines = diffManifests(m([]), m(many));
    expect(lines).toHaveLength(DIFF_LINE_CAP + 1);
    expect(lines.at(-1)).toBe("… and 5 more changes");
  });
});
