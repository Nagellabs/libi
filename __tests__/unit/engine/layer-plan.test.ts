import { describe, it, expect } from "vitest";
import { planLayer } from "@/lib/engine/overlay-renderer";
import { collectLayerRequests } from "@/lib/engine/renderer";
import type { Composition, Overlay } from "@/lib/engine/types";
import { MAX_LAYER_PIXEL_RATIO, MAX_LAYER_SIDE, parseHostMessage } from "@/lib/sandbox/protocol";

const base = { time: 1, fps: 30, width: 1920, height: 1080, renderScale: 2 };
const trackedCode = {
  id: "k1", kind: "tracked", trackId: "trk", startTime: 0, duration: 2, z: 0, opacity: 1,
  rect: { x: 0, y: 0, width: 10, height: 10 }, fit: "tight", scale: 1, smoothing: "none",
  content: { kind: "code", drawFunction: "" },
} as unknown as Overlay;
const codeAt = { id: "c2", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, drawFunction: "" };

describe("planLayer", () => {
  it("code: element-local timing, the rect as size, renderScale as pixelRatio, words when present", () => {
    const o = {
      id: "c1", kind: "code", startTime: 0.5, duration: 2, z: 0, opacity: 1,
      rect: { x: 10, y: 20, width: 300, height: 150 }, drawFunction: "",
      caption: { words: [{ text: "hi", start: 0, end: 1 }] },
    } as unknown as Overlay;
    const plan = planLayer(o, base)!;
    expect(plan.request).toEqual({
      overlayId: "c1", kind: "code", frame: 15, size: { width: 300, height: 150 }, pixelRatio: 2, fps: 30,
      time: { frame: 15, time: 0.5, totalFrames: 60, duration: 2, progress: 0.25, compositionTime: 1, overlayStart: 0.5, pieceDuration: 2.5 },
      words: [{ text: "hi", start: 0, end: 1 }],
    });
    expect(plan.request.pad).toBeUndefined(); // plain code stays clipped to its rect
    expect(plan.rollRad).toBe(0);
  });
  it("code: the request's timing carries the piece clock — compositionTime is the frame's own time, overlayStart the overlay's start, pieceDuration what the caller says", () => {
    const o = { id: "c1", kind: "code", startTime: 11.3, duration: 4, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, drawFunction: "" } as unknown as Overlay;
    const t = planLayer(o, { ...base, time: 12.5, pieceDuration: 24 })!.request.time;
    expect(t).toMatchObject({ compositionTime: 12.5, overlayStart: 11.3, pieceDuration: 24 });
    expect(t.time).toBeCloseTo(1.2, 9);
    expect(t.compositionTime).toBeCloseTo(t.overlayStart! + t.time, 9);
    // Without one, the piece is at least as long as the overlay runs.
    expect(planLayer(o, { ...base, time: 12.5 })!.request.time.pieceDuration).toBeCloseTo(15.3, 9);
    // The wire accepts it as planned.
    const { overlayId, ...rest } = planLayer(o, { ...base, time: 12.5, pieceDuration: 24 })!.request;
    expect(parseHostMessage({ t: "render", id: overlayId, req: 1, ...rest })).not.toBeNull();
  });
  it("code: inside a size-changing keyframe segment it sends the segment's two sizes; a static rect, a position-only segment and the hold after a tween send none", () => {
    const r = { x: 0, y: 0, width: 400, height: 200 };
    const tween = {
      ...codeAt, rect: r,
      keyframes: { rect: { keyframes: [{ t: 0, value: r }, { t: 0.25, value: { ...r, x: 300 } }, { t: 0.5, value: { ...r, x: 300, width: 800, height: 400 } }] } },
    } as unknown as Overlay;
    const at = (time: number) => planLayer(tween, { ...base, time })!.request;
    // 0–0.5 s (progress 0–0.25): the position-only segment — measured at the size itself.
    expect(at(0.2).fitSegment).toBeUndefined();
    // 0.5–1 s: the growing segment — one pair of ends for every frame of it.
    for (const time of [0.6, 0.75, 0.9]) {
      expect(at(time).fitSegment).toEqual({ from: { width: 400, height: 200 }, to: { width: 800, height: 400 } });
    }
    // The hold after the tween (progress ≥ 0.5) is static.
    expect(at(1.5).fitSegment).toBeUndefined();
    expect(at(1.5).size).toEqual({ width: 800, height: 400 });
    expect(planLayer({ ...codeAt, rect: r } as unknown as Overlay, base)!.request.fitSegment).toBeUndefined();
    const { overlayId, kind, ...rest } = at(0.75);
    expect(parseHostMessage({ t: "render", id: overlayId, req: 1, ...rest }), kind).not.toBeNull();
  });
  it("plans within the wire's caps, so a bitmap is placed by the geometry it was rendered at (Task 12b)", () => {
    const huge = { ...codeAt, rect: { x: 0, y: 0, width: 20000, height: 100 } } as unknown as Overlay;
    const plan = planLayer(huge, { ...base, renderScale: 16 })!;
    expect(plan.request.size).toEqual({ width: MAX_LAYER_SIDE, height: 100 });
    expect(plan.request.pixelRatio).toBeLessThanOrEqual(MAX_LAYER_PIXEL_RATIO);
    const { overlayId, kind, ...rest } = plan.request;
    expect(parseHostMessage({ t: "render", id: overlayId, req: 1, ...rest }), kind).not.toBeNull();
  });
  it("three: splits the screen roll out of transform3d and carries the spatial part", () => {
    const o = {
      id: "t1", kind: "three", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 400, height: 300 }, sceneFunction: "",
      transform3d: { position: { x: 0, y: 0, z: 1 }, rotation: { x: 0.2, y: 0.1, z: 0.5 } },
    } as unknown as Overlay;
    const plan = planLayer(o, base)!;
    expect(plan.request.kind).toBe("three");
    expect(plan.request.transform3d).toEqual({ position: { x: 0, y: 0, z: 1 }, rotation: { x: 0.2, y: 0.1, z: 0 } });
    expect(plan.rollRad).toBe(0.5);
  });
  it("tracked code: uses the resolved bbox handed in, and returns null without one", () => {
    const o = {
      id: "k1", kind: "tracked", trackId: "trk", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, fit: "tight", scale: 1, smoothing: "none",
      content: { kind: "code", drawFunction: "" },
    } as unknown as Overlay;
    const plan = planLayer(o, { ...base, trackedBbox: { x: 100, y: 200, w: 80, h: 60 } })!;
    expect(plan.request).toMatchObject({ kind: "tracked", size: { width: 80, height: 60 } });
    expect(planLayer(o, base)).toBeNull(); // no track, no bbox → nothing to render
  });
  it("tracked code: pads the layer by one bbox size on every side (review I1)", () => {
    const plan = planLayer(trackedCode, { ...base, trackedBbox: { x: 100, y: 200, w: 80, h: 60 } })!;
    expect(plan.request.pad).toEqual({ left: 80, top: 60, right: 80, bottom: 60 });
  });
  it("tracked code: the pad is cut back at the canvas edges, never past them", () => {
    // Near the top-left corner: only the room that is actually on the canvas.
    const tl = planLayer(trackedCode, { ...base, trackedBbox: { x: 10.7, y: 5.2, w: 80, h: 60 } })!;
    expect(tl.request.pad).toEqual({ left: 10, top: 5, right: 80, bottom: 60 });
    // Flush with the bottom-right corner: nothing on those sides.
    const br = planLayer(trackedCode, { ...base, trackedBbox: { x: 1840, y: 1020, w: 80, h: 60 } })!;
    expect(br.request.pad).toEqual({ left: 80, top: 60, right: 0, bottom: 0 });
    // Hanging off the canvas: no negative pad.
    const off = planLayer(trackedCode, { ...base, trackedBbox: { x: -30, y: 1060, w: 80, h: 60 } })!;
    expect(off.request.pad).toEqual({ left: 0, top: 60, right: 80, bottom: 0 });
  });
  it("rounds layer sizes to whole composition px (review M1)", () => {
    const plan = planLayer(trackedCode, { ...base, trackedBbox: { x: 100.25, y: 200.75, w: 80.4, h: 59.6 } })!;
    expect(plan.request.size).toEqual({ width: 80, height: 60 });
    const code = { ...codeAt, rect: { x: 0.5, y: 0.5, width: 10.6, height: 0.2 } } as unknown as Overlay;
    expect(planLayer(code, base)!.request.size).toEqual({ width: 11, height: 1 }); // never 0
  });
  it("returns null for kinds that carry no body", () => {
    const o = { id: "x", kind: "text", startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, content: "a" } as unknown as Overlay;
    expect(planLayer(o, base)).toBeNull();
  });
});

describe("collectLayerRequests", () => {
  it("plans every ACTIVE body overlay for the frame, in z order, skipping inactive ones", () => {
    const comp = {
      id: "c", name: "c", width: 100, height: 100, fps: 10, overlays: [
        { id: "late", kind: "code", startTime: 5, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, drawFunction: "" },
        { id: "b", kind: "code", startTime: 0, duration: 2, z: 2, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, drawFunction: "" },
        { id: "a", kind: "three", startTime: 0, duration: 2, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, sceneFunction: "" },
        { id: "txt", kind: "text", startTime: 0, duration: 2, z: 3, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, content: "t" },
      ],
    } as unknown as Composition;
    const reqs = collectLayerRequests(comp, 5, 1);
    expect(reqs.map((r) => r.overlayId)).toEqual(["a", "b"]);
    expect(reqs[0].time.frame).toBe(5);
    // pieceDuration is the piece's, not the overlay's: the latest overlay ends at 6 s.
    expect(reqs.map((r) => r.time.pieceDuration)).toEqual([6, 6]);
    expect(reqs.map((r) => r.time.compositionTime)).toEqual([0.5, 0.5]);
  });
});
