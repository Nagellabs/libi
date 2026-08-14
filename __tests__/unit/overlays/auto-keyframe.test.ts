import { describe, it, expect } from "vitest";
import {
  autoKeyframeCommit,
  mergePendingKeyframe,
} from "@/lib/overlays/auto-keyframe";

describe("autoKeyframeCommit", () => {
  const base = {
    field: "rect" as const,
    value: { x: 10, y: 20, width: 100, height: 50 },
    playheadTime: 5,
    startTime: 2,
    duration: 6,
  };

  it("returns flat when the overlay has no keyframes", () => {
    const d = autoKeyframeCommit({ ...base, hasKeyframes: false });
    expect(d).toEqual({ mode: "flat" });
  });

  it("returns a keyframe with clip-relative time + properties when animated", () => {
    const d = autoKeyframeCommit({ ...base, hasKeyframes: true });
    expect(d).toEqual({
      mode: "keyframe",
      time: 3, // playhead 5 − startTime 2
      properties: { rect: base.value },
    });
  });

  it("shapes properties from the changed field (opacity)", () => {
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      field: "opacity",
      value: 0.5,
    });
    expect(d).toEqual({
      mode: "keyframe",
      time: 3,
      properties: { opacity: 0.5 },
    });
  });

  it("shapes properties from the changed field (transform3d)", () => {
    const t3d = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.1 } };
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      field: "transform3d",
      value: t3d,
    });
    expect(d).toMatchObject({
      mode: "keyframe",
      properties: { transform3d: t3d },
    });
  });

  it("clamps a playhead BEFORE the clip window to the leading edge (0)", () => {
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      playheadTime: 1, // before startTime 2
    });
    expect(d).toMatchObject({ mode: "keyframe", time: 0 });
  });

  it("clamps a playhead AFTER the clip window to duration", () => {
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      playheadTime: 100, // 100 − 2 = 98, clamped to duration 6
    });
    expect(d).toMatchObject({ mode: "keyframe", time: 6 });
  });

  it("treats a non-positive duration as a zero-length window (time pins to 0)", () => {
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      duration: 0,
      playheadTime: 10,
    });
    expect(d).toMatchObject({ mode: "keyframe", time: 0 });
  });

  it("keeps time at the exact playhead offset inside the window", () => {
    const d = autoKeyframeCommit({
      ...base,
      hasKeyframes: true,
      playheadTime: 7.5,
      startTime: 2,
      duration: 6,
    });
    // 7.5 − 2 = 5.5, within [0, 6]
    expect(d).toMatchObject({ mode: "keyframe", time: 5.5 });
  });
});

describe("mergePendingKeyframe", () => {
  it("seeds a fresh intent when there is no prior pending entry", () => {
    const merged = mergePendingKeyframe(undefined, {
      time: 3,
      properties: { rect: { x: 1, y: 2, width: 10, height: 20 } },
    });
    expect(merged).toEqual({
      time: 3,
      properties: { rect: { x: 1, y: 2, width: 10, height: 20 } },
    });
  });

  it("merges properties field-by-field so multi-field drags land all fields", () => {
    const prev = { time: 3, properties: { rect: { x: 1, y: 2, width: 10, height: 20 } } };
    const merged = mergePendingKeyframe(prev, {
      time: 3,
      properties: { opacity: 0.4 },
    });
    expect(merged.properties).toEqual({
      rect: { x: 1, y: 2, width: 10, height: 20 },
      opacity: 0.4,
    });
  });

  it("keeps only the LATEST value per field across ticks (last write wins)", () => {
    const prev = { time: 3, properties: { rect: { x: 1, y: 1, width: 5, height: 5 } } };
    const merged = mergePendingKeyframe(prev, {
      time: 3,
      properties: { rect: { x: 99, y: 99, width: 5, height: 5 } },
    });
    expect(merged.properties.rect).toEqual({ x: 99, y: 99, width: 5, height: 5 });
  });

  it("takes the newest decision's time (re-targets a later drag at a new playhead)", () => {
    const prev = { time: 3, properties: { opacity: 0.5 } };
    const merged = mergePendingKeyframe(prev, { time: 4.2, properties: { opacity: 0.6 } });
    expect(merged.time).toBe(4.2);
  });

  it("does not mutate the prior pending entry", () => {
    const prev = { time: 3, properties: { rect: { x: 1, y: 2, width: 10, height: 20 } } };
    const snapshot = JSON.parse(JSON.stringify(prev));
    mergePendingKeyframe(prev, { time: 3, properties: { opacity: 0.4 } });
    expect(prev).toEqual(snapshot);
  });
});
