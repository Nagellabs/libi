import { describe, it, expect } from "vitest";
import type { ImageOverlay, TextOverlay, TrackedOverlay, Overlay } from "@/lib/engine/types";
import {
  overlayKeyframeTimes,
  snapshotValues,
  addKeyframeAt,
  deleteKeyframeAt,
  setSegmentEasing,
  allowedKeyframeProps,
  positionToRect,
  scaleRectAboutCenter,
  rotationDegToTransform,
} from "@/lib/overlays/keyframes";
import { valueAt } from "@/lib/engine/animatable";
import { elementTiming } from "@/lib/engine/overlay-timing";

function baseImageOverlay(partial: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "ov1",
    kind: "image",
    startTime: 0,
    duration: 4,
    z: 0,
    rect: { x: 100, y: 100, width: 200, height: 150 },
    opacity: 1,
    fileId: "file1",
    ...partial,
  };
}

describe("overlayKeyframeTimes", () => {
  it("returns [] when no keyframes", () => {
    expect(overlayKeyframeTimes(baseImageOverlay())).toEqual([]);
  });

  it("unions + sorts + dedupes times across all three tracks", () => {
    const ov = baseImageOverlay({
      keyframes: {
        rect: {
          keyframes: [
            { t: 0.5, value: { x: 0, y: 0, width: 10, height: 10 } },
            { t: 0, value: { x: 0, y: 0, width: 10, height: 10 } },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0.5, value: 0.5 }, // duplicate t with rect track
            { t: 1, value: 1 },
          ],
        },
        transform3d: {
          keyframes: [
            { t: 0.25, value: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } },
          ],
        },
      },
    });
    expect(overlayKeyframeTimes(ov)).toEqual([0, 0.25, 0.5, 1]);
  });
});

describe("addKeyframeAt", () => {
  it("seeds all three tracks from base when props omitted (single key each)", () => {
    const ov = baseImageOverlay();
    const patch = addKeyframeAt(ov, 0);
    expect(patch.keyframes.rect?.keyframes).toEqual([
      { t: 0, value: { x: 100, y: 100, width: 200, height: 150 } },
    ]);
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0, value: 1 }]);
    // transform3d resolves to identity for a bare overlay
    expect(patch.keyframes.transform3d?.keyframes[0].value).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  });

  it("adds a second key so a track actually animates", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0) } as ImageOverlay;
    const patch = addKeyframeAt(ov, 1, {
      rect: { x: 500, y: 100, width: 200, height: 150 },
    });
    expect(patch.keyframes.rect?.keyframes).toEqual([
      { t: 0, value: { x: 100, y: 100, width: 200, height: 150 } },
      { t: 1, value: { x: 500, y: 100, width: 200, height: 150 } },
    ]);
    // Resolve mid-way: rect x should interpolate 100 → 500 → 300 at progress 0.5.
    const resolved = valueAt(
      patch.keyframes.rect!,
      elementTiming(2, 30, 0, 4), // progress 0.5
    );
    expect(resolved.x).toBeCloseTo(300);
  });

  it("only keys the named prop when props is a subset", () => {
    const ov = baseImageOverlay();
    const patch = addKeyframeAt(ov, 0.25, { opacity: 0.3 });
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0.25, value: 0.3 }]);
    expect(patch.keyframes.rect).toBeUndefined();
    expect(patch.keyframes.transform3d).toBeUndefined();
  });

  it("replaces (not duplicates) a keyframe at the same t", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.2 }) } as ImageOverlay;
    const patch = addKeyframeAt(ov, 0.5, { opacity: 0.9 });
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0.5, value: 0.9 }]);
  });

  it("keeps each track sorted by t after an out-of-order add", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 1, { opacity: 1 }) } as ImageOverlay;
    const patch = addKeyframeAt(ov, 0, { opacity: 0 });
    expect(patch.keyframes.opacity?.keyframes.map((k) => k.t)).toEqual([0, 1]);
  });

  it("preserves an existing key's easing when only its value is replaced", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.2 }) } as ImageOverlay;
    ov = { ...ov, ...setSegmentEasing(ov, 0.5, "ease-out") } as ImageOverlay;
    const patch = addKeyframeAt(ov, 0.5, { opacity: 0.9 });
    expect(patch.keyframes.opacity?.keyframes[0]).toEqual({
      t: 0.5,
      value: 0.9,
      easing: "ease-out",
    });
  });

  it("snaps to a nearby existing keyframe within tolerance, keeping its t", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.2 }) } as ImageOverlay;
    // Edit lands off 0.5 but within tolerance → UPDATE the 0.5 key (keep its t),
    // not drop a near-duplicate a hair away.
    const patch = addKeyframeAt(ov, 0.51, { opacity: 0.9 }, 0.02);
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0.5, value: 0.9 }]);
  });

  it("inserts a new key when the nearest existing keyframe is outside tolerance", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.2 }) } as ImageOverlay;
    const patch = addKeyframeAt(ov, 0.6, { opacity: 0.9 }, 0.02);
    expect(patch.keyframes.opacity?.keyframes).toEqual([
      { t: 0.5, value: 0.2 },
      { t: 0.6, value: 0.9 },
    ]);
  });

  it("snap-update preserves the matched key's easing", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.2 }) } as ImageOverlay;
    ov = { ...ov, ...setSegmentEasing(ov, 0.5, "ease-out") } as ImageOverlay;
    const patch = addKeyframeAt(ov, 0.49, { opacity: 0.9 }, 0.02);
    expect(patch.keyframes.opacity?.keyframes[0]).toEqual({
      t: 0.5,
      value: 0.9,
      easing: "ease-out",
    });
  });

  it("does not alias the base rect — mutating the stored value can't change the overlay", () => {
    const ov = baseImageOverlay();
    // props omitted → snapshot from base; base rect is a constant, so valueAt
    // returns the very same object. The stored keyframe value must be a clone.
    const patch = addKeyframeAt(ov, 0);
    const stored = patch.keyframes.rect?.keyframes[0].value as { x: number };
    expect(stored).not.toBe(ov.rect);
    stored.x = 999;
    expect(ov.rect.x).toBe(100);
  });
});

describe("deleteKeyframeAt", () => {
  it("keeps a lone remaining keyframe (individual delete) — track NOT dropped", () => {
    // opacity track has 2 keys, rect has 3. Deleting the key at t=1 leaves
    // opacity with 1 key → KEEP it (constant hold); rect keeps 2 → survives.
    const ov = baseImageOverlay({
      keyframes: {
        rect: {
          keyframes: [
            { t: 0, value: { x: 0, y: 0, width: 10, height: 10 } },
            { t: 0.5, value: { x: 5, y: 0, width: 10, height: 10 } },
            { t: 1, value: { x: 10, y: 0, width: 10, height: 10 } },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 1, value: 1 },
          ],
        },
      },
    });

    const patch = deleteKeyframeAt(ov, 1);
    expect(patch.keyframes).not.toBeNull();
    // opacity track KEEPS its single remaining key (t=0) — no collapse
    const op = (patch.keyframes as { opacity?: { keyframes: { t: number }[] } }).opacity;
    expect(op?.keyframes.length).toBe(1);
    expect(op?.keyframes[0].t).toBe(0);
    // rect track survives with 2 keys
    expect((patch.keyframes as { rect?: { keyframes: unknown[] } }).rect?.keyframes.length).toBe(2);
  });

  it("clears keyframes (null sentinel) only when the LAST keyframe is deleted", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0, { opacity: 0 }) } as ImageOverlay;
    ov = { ...ov, ...addKeyframeAt(ov, 1, { opacity: 1 }) } as ImageOverlay;
    // Delete one → a lone key survives (individual delete, not cleared).
    const afterFirst = deleteKeyframeAt(ov, 0);
    expect(afterFirst.keyframes).not.toBeNull();
    expect(
      (afterFirst.keyframes as { opacity?: { keyframes: unknown[] } }).opacity?.keyframes.length,
    ).toBe(1);
    // Delete the last remaining key → now cleared via the null sentinel.
    ov = { ...ov, keyframes: afterFirst.keyframes } as ImageOverlay;
    expect(deleteKeyframeAt(ov, 1).keyframes).toBeNull();
  });

  it("keeps a track with ≥2 remaining keys", () => {
    let ov = baseImageOverlay();
    ov = { ...ov, ...addKeyframeAt(ov, 0, { opacity: 0 }) } as ImageOverlay;
    ov = { ...ov, ...addKeyframeAt(ov, 0.5, { opacity: 0.5 }) } as ImageOverlay;
    ov = { ...ov, ...addKeyframeAt(ov, 1, { opacity: 1 }) } as ImageOverlay;
    const patch = deleteKeyframeAt(ov, 0.5);
    expect((patch.keyframes as { opacity?: { keyframes: unknown[] } }).opacity?.keyframes.length).toBe(2);
  });

  it("removes the time from every track (union delete)", () => {
    const ov = baseImageOverlay({
      keyframes: {
        rect: {
          keyframes: [
            { t: 0, value: { x: 0, y: 0, width: 10, height: 10 } },
            { t: 0.5, value: { x: 5, y: 0, width: 10, height: 10 } },
            { t: 1, value: { x: 10, y: 0, width: 10, height: 10 } },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 0.5, value: 0.5 },
            { t: 1, value: 1 },
          ],
        },
      },
    });
    const patch = deleteKeyframeAt(ov, 0.5);
    const kf = patch.keyframes as { rect?: { keyframes: { t: number }[] }; opacity?: { keyframes: { t: number }[] } };
    expect(kf.rect?.keyframes.map((k) => k.t)).toEqual([0, 1]);
    expect(kf.opacity?.keyframes.map((k) => k.t)).toEqual([0, 1]);
  });
});

describe("setSegmentEasing", () => {
  it("sets .easing on the LEFT keyframe at t", () => {
    const ov = baseImageOverlay({
      keyframes: {
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 1, value: 1 },
          ],
        },
      },
    });
    const patch = setSegmentEasing(ov, 0, "ease-in-out");
    const kf = patch.keyframes as { opacity?: { keyframes: { t: number; easing?: string }[] } };
    expect(kf.opacity?.keyframes[0].easing).toBe("ease-in-out");
    expect(kf.opacity?.keyframes[1].easing).toBeUndefined();
  });

  it("sets easing on whichever tracks have a key at t", () => {
    const ov = baseImageOverlay({
      keyframes: {
        rect: {
          keyframes: [
            { t: 0.25, value: { x: 0, y: 0, width: 1, height: 1 } },
            { t: 0.75, value: { x: 1, y: 0, width: 1, height: 1 } },
          ],
        },
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 0.25, value: 0.25 },
          ],
        },
      },
    });
    const patch = setSegmentEasing(ov, 0.25, "cubic-bezier(0.5,0,0.5,1)");
    const kf = patch.keyframes as {
      rect?: { keyframes: { t: number; easing?: string }[] };
      opacity?: { keyframes: { t: number; easing?: string }[] };
    };
    expect(kf.rect?.keyframes[0].easing).toBe("cubic-bezier(0.5,0,0.5,1)");
    expect(kf.opacity?.keyframes[1].easing).toBe("cubic-bezier(0.5,0,0.5,1)");
  });
});

describe("property→value helpers (dedup source of truth)", () => {
  const baseRect = { x: 10, y: 20, width: 100, height: 50 };
  const baseTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };

  it("positionToRect keeps base w/h and moves the origin", () => {
    expect(positionToRect(baseRect, { x: 200, y: 300 })).toEqual({
      x: 200,
      y: 300,
      width: 100,
      height: 50,
    });
  });

  it("scaleRectAboutCenter doubles about the center (center preserved)", () => {
    const scaled = scaleRectAboutCenter(baseRect, 2);
    // base center = (60, 45); at 2× the box doubles about it.
    expect(scaled).toEqual({ x: -40, y: -5, width: 200, height: 100 });
    expect(scaled.x + scaled.width / 2).toBe(60);
    expect(scaled.y + scaled.height / 2).toBe(45);
  });

  it("rotationDegToTransform converts degrees→radians on rotation.z only", () => {
    const t = rotationDegToTransform(baseTransform, 90);
    expect(t.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(t.rotation.x).toBe(0);
    expect(t.rotation.y).toBe(0);
    expect(t.position).toEqual(baseTransform.position);
  });
});

describe("snapshotValues", () => {
  it("reads base fields when no keyframes exist", () => {
    const ov = baseImageOverlay({ opacity: 0.7 });
    const snap = snapshotValues(ov, 0.5);
    expect(snap.rect).toEqual({ x: 100, y: 100, width: 200, height: 150 });
    expect(snap.opacity).toBe(0.7);
    expect(snap.transform3d).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  });

  it("resolves a keyframed track at normalized t", () => {
    const ov = baseImageOverlay({
      keyframes: {
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 1, value: 1 },
          ],
        },
      },
    });
    expect(snapshotValues(ov, 0.25).opacity).toBeCloseTo(0.25);
  });
});

describe("allowedKeyframeProps (D9 tracked guard)", () => {
  it("tracked overlays allow opacity only", () => {
    expect(allowedKeyframeProps("tracked")).toEqual(["opacity"]);
  });

  it("all other kinds allow rect/opacity/transform3d", () => {
    for (const kind of ["text", "image", "video", "code", "three"] as const) {
      expect(allowedKeyframeProps(kind)).toEqual(["rect", "opacity", "transform3d"]);
    }
  });

  it("addKeyframeAt ignores disallowed props on a tracked overlay", () => {
    const tracked: TrackedOverlay = {
      id: "tk",
      kind: "tracked",
      startTime: 0,
      duration: 3,
      z: 0,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      opacity: 1,
      trackId: "trk1",
      content: { kind: "emoji", char: "🔥" },
      fit: "head",
      scale: 1,
      smoothing: "linear",
    };
    // Request all three; only opacity survives on a tracked overlay.
    const patch = addKeyframeAt(tracked, 0, {
      rect: { x: 5, y: 5, width: 20, height: 20 },
      opacity: 0.5,
      transform3d: { position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
    });
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0, value: 0.5 }]);
    expect(patch.keyframes.rect).toBeUndefined();
    expect(patch.keyframes.transform3d).toBeUndefined();
  });

  it("addKeyframeAt with props omitted on a tracked overlay snapshots opacity only", () => {
    const tracked: TrackedOverlay = {
      id: "tk",
      kind: "tracked",
      startTime: 0,
      duration: 3,
      z: 0,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      opacity: 0.8,
      trackId: "trk1",
      content: { kind: "emoji", char: "🔥" },
      fit: "head",
      scale: 1,
      smoothing: "linear",
    };
    const patch = addKeyframeAt(tracked, 0);
    expect(patch.keyframes.opacity?.keyframes).toEqual([{ t: 0, value: 0.8 }]);
    expect(patch.keyframes.rect).toBeUndefined();
    expect(patch.keyframes.transform3d).toBeUndefined();
  });
});

describe("purity", () => {
  it("never mutates the input overlay's keyframes", () => {
    const ov = baseImageOverlay({
      keyframes: {
        opacity: {
          keyframes: [
            { t: 0, value: 0 },
            { t: 1, value: 1 },
          ],
        },
      },
    });
    const before = JSON.stringify(ov.keyframes);
    addKeyframeAt(ov, 0.5, { opacity: 0.5 });
    deleteKeyframeAt(ov, 0);
    setSegmentEasing(ov, 0, "linear");
    expect(JSON.stringify(ov.keyframes)).toBe(before);
  });
});

// A render-resolve test: a keyframed rect yields DIFFERENT geometry at
// progress 0 vs 1, while a non-keyframed overlay resolves to its base rect.
describe("renderer resolve expression (keyframes.rect ?? rect)", () => {
  const resolveRect = (ov: Overlay, progress: number) =>
    valueAt(ov.keyframes?.rect ?? ov.rect, { frame: 0, time: 0, totalFrames: 1, duration: 1, progress });

  it("keyframed rect differs across progress 0 vs 1", () => {
    const ov = baseImageOverlay({
      keyframes: {
        rect: {
          keyframes: [
            { t: 0, value: { x: 0, y: 0, width: 100, height: 100 } },
            { t: 1, value: { x: 800, y: 0, width: 100, height: 100 } },
          ],
        },
      },
    });
    expect(resolveRect(ov, 0).x).toBe(0);
    expect(resolveRect(ov, 1).x).toBe(800);
  });

  it("non-keyframed overlay resolves to its base rect unchanged", () => {
    const ov = baseImageOverlay();
    expect(resolveRect(ov, 0)).toEqual(ov.rect);
    expect(resolveRect(ov, 1)).toEqual(ov.rect);
  });
});
