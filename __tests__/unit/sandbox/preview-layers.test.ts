import { describe, it, expect, vi } from "vitest";
import { PreviewLayerSource, subscribeOncePerFrame } from "@/lib/sandbox/preview-layers";
import type { LayerRequest } from "@/lib/engine/layer-source";

const timing = (frame: number) => ({ frame, time: frame / 30, totalFrames: 60, duration: 2, progress: frame / 60 });
const req = (frame: number, id = "o1", extra: Partial<LayerRequest> = {}): LayerRequest => ({
  overlayId: id,
  kind: "code",
  frame,
  size: { width: 10, height: 10 },
  pixelRatio: 1,
  fps: 30,
  time: timing(frame),
  ...extra,
});
const bmp = () => ({ width: 1, height: 1, close: vi.fn() });
const geometry = { size: { width: 10, height: 10 }, pixelRatio: 1 };

describe("PreviewLayerSource (spec §4.5 — hold-last-good)", () => {
  it("posts a render for the requested frame when none is in flight, and coalesces while one is", () => {
    const post = vi.fn<(r: LayerRequest) => number>(() => 1);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.request(req(4));
    src.request(req(5));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ frame: 3 });
  });

  it("on arrival stores the bitmap, notifies subscribers once, then sends the LATEST pending frame", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    const listener = vi.fn();
    src.subscribe(listener);
    src.request(req(3));
    src.request(req(5));
    const b3 = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: b3 as never });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(src.get("o1", 5)).toEqual({ frame: 3, bitmap: b3, ...geometry }); // last good, even though 5 was asked
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toMatchObject({ frame: 5 });
    const b5 = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 5, req: 2, bitmap: b5 as never });
    expect(b3.close).toHaveBeenCalled(); // ≤ 1 last-good bitmap per overlay (spec §6)
    expect(src.get("o1", 5)).toEqual({ frame: 5, bitmap: b5, ...geometry });
  });

  it("does not re-request a request it already holds", () => {
    const post = vi.fn<(r: LayerRequest) => number>(() => 1);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: bmp() as never });
    src.request(req(3));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("re-renders the SAME frame when anything else in the request changed (paused resize, rect drag, inspector edit)", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: bmp() as never });
    const variants: Array<Partial<LayerRequest>> = [
      { pixelRatio: 2 },
      { size: { width: 20, height: 10 } },
      { pad: { left: 1, top: 0, right: 0, bottom: 0 } },
      { transform3d: { position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 } } },
      { words: [{ text: "hi", start: 0, end: 1 }] },
    ];
    for (const v of variants) {
      src.request(req(3, "o1", v));
      const r = nextReq - 1;
      src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: r, bitmap: bmp() as never });
    }
    expect(post).toHaveBeenCalledTimes(1 + variants.length);
    // …and an equal-by-value request (fresh objects) is still a no-op.
    src.request(req(3, "o1", { words: [{ text: "hi", start: 0, end: 1 }] }));
    expect(post).toHaveBeenCalledTimes(1 + variants.length);
  });

  it("while a render is in flight, a same-frame request with a new size is queued, and an identical one clears the queue", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.request(req(3, "o1", { pixelRatio: 2 }));
    src.request(req(3)); // back to what is already in flight — nothing to queue
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: bmp() as never });
    expect(post).toHaveBeenCalledTimes(1);
    src.request(req(3, "o1", { pixelRatio: 2 }));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("attaches the geometry of the request the reply ANSWERS, never the latest request's", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    const pad = { left: 2, top: 3, right: 4, bottom: 5 };
    src.request(req(3, "o1", { size: { width: 10, height: 10 }, pixelRatio: 1, pad }));
    src.request(req(4, "o1", { size: { width: 40, height: 30 }, pixelRatio: 2 })); // pending
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: b as never });
    expect(src.get("o1", 4)).toEqual({ frame: 3, bitmap: b, size: { width: 10, height: 10 }, pixelRatio: 1, pad });
  });

  it("a layer answering a request it never posted is closed and ignored", () => {
    const post = vi.fn<(r: LayerRequest) => number>(() => 1);
    const src = new PreviewLayerSource(post);
    const listener = vi.fn();
    src.subscribe(listener);
    src.request(req(3));
    const stray = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 99, bitmap: stray as never });
    expect(stray.close).toHaveBeenCalled();
    expect(src.get("o1", 3)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("a layer that lands after release() is still placed by the request it answers", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(3, "o1", { pixelRatio: 2 }));
    src.release("o1"); // e.g. a compile error for a newer source while this render was out
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: b as never });
    expect(src.get("o1", 3)).toMatchObject({ frame: 3, pixelRatio: 2 });
  });

  it("a post that returns -1 (not loaded / dropped) leaves nothing in flight, so the next request retries", () => {
    const post = vi.fn<(r: LayerRequest) => number>(() => -1);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.request(req(4));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("release frees the slot for the next request and keeps the last-good bitmap", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(1));
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 1, bitmap: b as never });
    src.request(req(2));
    src.release("o1");
    src.request(req(2));
    expect(post).toHaveBeenCalledTimes(3);
    expect(src.get("o1", 2)?.bitmap).toBe(b);
    expect(b.close).not.toHaveBeenCalled();
  });

  it("releaseAll frees every slot (a worker restart abandoned all renders) without dropping bitmaps", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(1, "a"));
    src.request(req(1, "b"));
    src.releaseAll();
    src.request(req(1, "a"));
    src.request(req(1, "b"));
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("markStale re-sends the same request (a new body on a paused preview) and keeps the held bitmap meanwhile", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: b as never });
    src.markStale("o1");
    expect(src.get("o1", 3)?.bitmap).toBe(b);
    src.request(req(3));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("markStale while a render is OUT: its answer is shown, but the same request goes out again (Task 12b — a font landing on a paused preview)", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(3));
    src.markStale("o1"); // e.g. the fonts landed while render 1 was out: it may have drawn the fallback
    src.request(req(3)); // the repaint asks for the same frame: joins the one out
    expect(post).toHaveBeenCalledTimes(1);
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 1, bitmap: b as never });
    expect(src.get("o1", 3)?.bitmap).toBe(b);
    src.request(req(3));
    expect(post).toHaveBeenCalledTimes(2);
    // That one answers the current body: a repeat is skipped again.
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 3, req: 2, bitmap: bmp() as never });
    src.request(req(3));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("invalidate notifies subscribers without touching any slot", () => {
    const src = new PreviewLayerSource(vi.fn<(r: LayerRequest) => number>(() => 1));
    const listener = vi.fn();
    const off = src.subscribe(listener);
    src.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    src.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("waitForLayers resolves once every in-flight or pending overlay has a bitmap for that frame", async () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(7, "a"));
    src.request(req(7, "b"));
    let settled = false;
    const p = src.waitForLayers(7).then(() => {
      settled = true;
    });
    src.accept({ t: "layer", nonce: "n", id: "a", frame: 7, req: 1, bitmap: bmp() as never });
    await Promise.resolve();
    expect(settled).toBe(false);
    src.accept({ t: "layer", nonce: "n", id: "b", frame: 7, req: 2, bitmap: bmp() as never });
    await p;
    expect(settled).toBe(true);
  });

  it("waitForLayers gives up after its timeout so a dropped overlay can never hang a caller", async () => {
    vi.useFakeTimers();
    try {
      const src = new PreviewLayerSource(vi.fn<(r: LayerRequest) => number>(() => 1));
      src.request(req(7));
      let settled = false;
      void src.waitForLayers(7, 50).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forget drops the bitmap and closes it; dispose closes everything", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(1, "a"));
    src.request(req(1, "b"));
    const a = bmp();
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "a", frame: 1, req: 1, bitmap: a as never });
    src.accept({ t: "layer", nonce: "n", id: "b", frame: 1, req: 2, bitmap: b as never });
    src.forget("a");
    expect(a.close).toHaveBeenCalled();
    expect(src.get("a", 1)).toBeNull();
    src.dispose();
    expect(b.close).toHaveBeenCalled();
    expect(src.get("b", 1)).toBeNull();
  });

  it("without a connected sandbox nothing is sent; connect routes the next request", () => {
    const src = new PreviewLayerSource();
    src.request(req(1));
    const post = vi.fn<(r: LayerRequest) => number>(() => 7);
    src.connect(post);
    src.request(req(1));
    expect(post).toHaveBeenCalledTimes(1);
    src.connect(null);
    src.releaseAll();
    src.request(req(2));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reset closes every held bitmap but keeps subscribers and keeps working", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    const listener = vi.fn();
    src.subscribe(listener);
    src.request(req(1));
    const b = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 1, bitmap: b as never });
    src.reset();
    expect(b.close).toHaveBeenCalled();
    expect(src.get("o1", 1)).toBeNull();
    src.request(req(1));
    expect(post).toHaveBeenCalledTimes(2);
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 2, bitmap: bmp() as never });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("after dispose, arrivals are closed and requests post nothing", () => {
    const post = vi.fn<(r: LayerRequest) => number>(() => 1);
    const src = new PreviewLayerSource(post);
    src.request(req(1));
    src.dispose();
    const late = bmp();
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 1, bitmap: late as never });
    expect(late.close).toHaveBeenCalled();
    src.request(req(2));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("release with a req frees the slot only when that req is the render in flight (fix round 1, minor 1)", () => {
    let nextReq = 1;
    const post = vi.fn<(r: LayerRequest) => number>(() => nextReq++);
    const src = new PreviewLayerSource(post);
    src.request(req(1)); // req 1
    src.release("o1", 1); // its error: freed
    src.request(req(2)); // req 2, in flight
    src.release("o1", 1); // a late error answering the OLD render
    src.request(req(3)); // must queue behind req 2, not post over it
    expect(post).toHaveBeenCalledTimes(2);
    src.accept({ t: "layer", nonce: "n", id: "o1", frame: 2, req: 2, bitmap: bmp() as never });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][0]).toMatchObject({ frame: 3 });
    src.release("o1", 3); // the render it answers: freed
    src.request(req(4));
    expect(post).toHaveBeenCalledTimes(4);
  });
});

describe("subscribeOncePerFrame (fix round 1, minor 6)", () => {
  it("coalesces every notification within one animation frame into one call, and cancels on unsubscribe", () => {
    const src = new PreviewLayerSource(() => -1);
    const queued: Array<() => void> = [];
    let handles = 0;
    const schedule = vi.fn((cb: () => void) => {
      queued.push(cb);
      return ++handles;
    });
    const cancel = vi.fn();
    const listener = vi.fn();
    const off = subscribeOncePerFrame(src, listener, schedule, cancel);
    src.invalidate();
    src.invalidate();
    src.invalidate();
    expect(listener).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    queued.shift()!();
    expect(listener).toHaveBeenCalledTimes(1);
    src.invalidate(); // a later frame schedules again
    expect(schedule).toHaveBeenCalledTimes(2);
    off();
    expect(cancel).toHaveBeenCalledWith(2);
    src.invalidate();
    expect(schedule).toHaveBeenCalledTimes(2);
  });
});
