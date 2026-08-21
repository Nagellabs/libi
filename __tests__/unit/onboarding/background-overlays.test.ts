/**
 * The film's six beats, as full-frame `code` overlays.
 *
 * They were canvas scenes until 2026-08-20. A scene had no startTime, rect, z
 * or opacity — its position was implicit in `sceneOrder` plus the running sum
 * of durations — so the six layers a user most wants to nudge were the only
 * ones the editor could not move. Converting them is what retired the scene
 * layer, and these assertions are what keep the conversion honest.
 */
import { describe, it, expect } from "vitest";
import { ONBOARDING_PIECE_V1 as D } from "@/lib/onboarding/piece/v1";

const SLOTS = [
  { name: "SLOT A — chat: type the prompt", startTime: 0, duration: 4 },
  { name: "SLOT B — agent builds (montage)", startTime: 4, duration: 6 },
  { name: "SLOT C — generation + bg removal", startTime: 10, duration: 6 },
  { name: "SLOT D — tracking + code overlay", startTime: 16, duration: 8 },
  { name: "SLOT E — human editing", startTime: 24, duration: 2.5 },
  { name: "SLOT F — export", startTime: 26.5, duration: 3.5 },
];

const backgrounds = D.overlays.filter((o) => o.z === 0);

describe("onboarding v1 background overlays", () => {
  it("carries no scene fields at all", () => {
    expect((D as unknown as { scenes?: unknown }).scenes).toBeUndefined();
    expect((D as unknown as { sceneOrder?: unknown }).sceneOrder).toBeUndefined();
  });

  it("lays the six slots end to end as full-frame code overlays", () => {
    expect(backgrounds).toHaveLength(6);
    expect(backgrounds.map((o) => o.displayName)).toEqual(SLOTS.map((s) => s.name));
    expect(backgrounds.map((o) => o.startTime)).toEqual(SLOTS.map((s) => s.startTime));
    expect(backgrounds.map((o) => o.duration)).toEqual(SLOTS.map((s) => s.duration));
    for (const o of backgrounds) {
      expect(o.kind, o.id).toBe("code");
      expect(o.rect, o.id).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
      expect(o.opacity, o.id).toBe(1);
    }
  });

  it("leaves no gap and no overlap between consecutive beats", () => {
    for (let i = 1; i < backgrounds.length; i++) {
      const prev = backgrounds[i - 1];
      expect(backgrounds[i].startTime, backgrounds[i].id).toBeCloseTo(
        prev.startTime + prev.duration,
        6,
      );
    }
  });

  it("sits under every other layer", () => {
    const others = D.overlays.filter((o) => o.z !== 0);
    expect(others).toHaveLength(20);
    expect(Math.min(...others.map((o) => o.z))).toBeGreaterThan(0);
  });

  it("comes first in the array, so a same-z tie stacks it underneath", () => {
    // `overlaysActiveAt` stable-sorts on z and leaves array order as the
    // tiebreak. Backgrounds trailing the array would paint OVER a z-0 sibling.
    expect(D.overlays.slice(0, 6).every((o) => o.z === 0)).toBe(true);
  });

  it("every background body fills the frame, so content-fit stays identity", () => {
    // A code overlay's ink bbox is measured and contain-fitted into its rect; a
    // scene was never scaled. A body that stopped filling the frame would be
    // silently scaled UP — the whole beat reframed, with nothing failing.
    for (const o of backgrounds) {
      const draw = (o as unknown as { drawFunction: string }).drawFunction;
      expect(draw, o.id).toMatch(/fillRect\(\s*0\s*,\s*0\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/);
    }
  });

  it("exposes beats that agree with the backgrounds", () => {
    // `describeOnboardingPiece` reads `beats` to tell a first-run user what the
    // film contains. Emitted as data rather than sniffed from `displayName`, so
    // the two must be checked against each other somewhere — here.
    expect(D.beats).toHaveLength(6);
    expect(D.beats.map((b) => b.name)).toEqual(backgrounds.map((o) => o.displayName));
    expect(D.beats.map((b) => b.startTime)).toEqual(backgrounds.map((o) => o.startTime));
    expect(D.beats.map((b) => b.duration)).toEqual(backgrounds.map((o) => o.duration));
  });
});
