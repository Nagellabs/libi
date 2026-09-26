import { describe, it, expect, vi } from "vitest";
import { ExportLayerSource, buildExportDiagnosticsReport } from "@/lib/sandbox/export-layers";
import { OverlaySandbox, type RenderInput } from "@/lib/sandbox/host";
import { PROTOCOL_VERSION } from "@/lib/sandbox/protocol";
import { sameLayerRequest, type LayerRequest } from "@/lib/engine/layer-source";
import { sameLayerRequest as previewSameLayerRequest } from "@/lib/sandbox/preview-layers";

const timing = (frame: number) => ({ frame, time: frame / 30, totalFrames: 60, duration: 2, progress: frame / 60 });
const req = (id: string, frame: number, extra: Partial<LayerRequest> = {}): LayerRequest => ({
  overlayId: id, kind: "code", frame, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing(frame), ...extra,
});
const bmp = () => ({ width: 1, height: 1, close: vi.fn() });
/** The composition frame and second the export is on. */
const at = (frame: number) => ({ frame, time: frame / 30 });

/** The sandbox's `render`, as a counter: returns 1, 2, 3… like the real one. */
function stubPost() {
  let seq = 0;
  return vi.fn<(input: RenderInput) => number>(() => ++seq);
}

const layer = (id: string, frame: number, r: number, bitmap = bmp()) =>
  ({ t: "layer" as const, nonce: "n", id, frame, req: r, bitmap: bitmap as never });

describe("ExportLayerSource (spec §4.6)", () => {
  it("settle posts every request — the whole request, pad included — ONE AT A TIME, and resolves when all layers for that frame arrived", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post);
    const pad = { left: 4, top: 5, right: 6, bottom: 7 };
    const p = src.settle([req("a", 3), req("b", 3, { kind: "tracked", pad })], at(3));
    // The next render goes out only once this one answered: the worker is
    // serial, and each host watchdog must time only its own render.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ id: "a", frame: 3, fps: 30 });
    let done = false;
    void p.then(() => { done = true; });
    const ba = bmp();
    src.onLayer(layer("a", 3, 1, ba));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    // Spread, not hand-copied: a tracked layer rendered without its pad lands offset.
    expect(post.mock.calls[1][0]).toMatchObject({ id: "b", pad });
    expect(post.mock.calls[1][0]).not.toHaveProperty("overlayId");
    expect(done).toBe(false);
    const bb = bmp();
    src.onLayer(layer("b", 3, 2, bb));
    await p;
    expect(src.get("a", 3)).toEqual({ frame: 3, bitmap: ba, size: { width: 10, height: 10 }, pixelRatio: 1 });
    // Placed by the geometry of the request the reply ANSWERS (Task 8 N1).
    expect(src.get("b", 3)).toEqual({ frame: 3, bitmap: bb, size: { width: 10, height: 10 }, pixelRatio: 1, pad });
    expect(src.failureFor("a")).toBeUndefined();
  });

  it("the next settle closes the previous frame's bitmaps (one bitmap per overlay in memory)", async () => {
    const src = new ExportLayerSource(stubPost());
    const p1 = src.settle([req("a", 0)], at(0));
    const b0 = bmp();
    src.onLayer(layer("a", 0, 1, b0));
    await p1;
    const p2 = src.settle([req("a", 1)], at(1));
    const b1 = bmp();
    src.onLayer(layer("a", 1, 2, b1));
    await p2;
    expect(b0.close).toHaveBeenCalled();
    expect(src.get("a", 1)?.bitmap).toBe(b1);
    expect(src.get("a", 0)).toBeNull();
  });

  it("request() is a no-op, and settling a request identical to the one already answered posts nothing (drawBodyLayer asks on every draw)", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post);
    const p = src.settle([req("a", 2)], at(2));
    src.onLayer(layer("a", 2, 1));
    await p;
    src.request(req("a", 2));
    src.request(req("a", 9));
    await src.settle([req("a", 2)], at(2));
    expect(post).toHaveBeenCalledTimes(1);
    expect(src.get("a", 2)).not.toBeNull();
  });

  it("a render error answering the request fails that overlay for THIS frame, with the composition time; the next frame is tried again", async () => {
    const src = new ExportLayerSource(stubPost());
    const p1 = src.settle([req("a", 0)], at(0));
    const b0 = bmp();
    src.onLayer(layer("a", 0, 1, b0));
    await p1;
    const p2 = src.settle([req("a", 5)], at(5));
    src.onError({ t: "error", nonce: "n", id: "a", phase: "render", req: 2, message: "x is not defined", line: 2, column: 1 });
    await p2;
    expect(src.get("a", 5)).toBeNull();
    expect(b0.close).toHaveBeenCalled(); // the old frame's pixels never stand in for a failed one
    expect(src.failureFor("a")).toEqual({ phase: "render", message: "x is not defined", line: 2, column: 1, time: 5 / 30, frame: 5 });
    expect(src.failures.get("a")).toEqual({ phase: "render", message: "x is not defined", line: 2, column: 1, time: 5 / 30, frame: 5 });
    const p3 = src.settle([req("a", 6)], at(6));
    src.onLayer(layer("a", 6, 3));
    await p3;
    expect(src.failureFor("a")).toBeUndefined();
    expect(src.get("a", 6)).not.toBeNull();
    // The first failure is what the agent is told about — it names the frame to re-render.
    expect(src.failures.get("a")?.time).toBe(5 / 30);
  });

  it("a timeout fails the offender; the renders after it wait for the fresh worker and its reload, then go out", async () => {
    const post = stubPost();
    let reloaded = 0;
    const src = new ExportLayerSource(post, { reloadAll: async () => { reloaded++; } });
    const p = src.settle([req("a", 5), req("b", 5)], at(5));
    expect(post).toHaveBeenCalledTimes(1);
    src.onTimeout("a", "render");
    // Nothing is posted until the fresh worker says it is up.
    await Promise.resolve();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    src.onRestart();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(reloaded).toBe(1);
    expect(post.mock.calls[1][0]).toMatchObject({ id: "b", frame: 5 });
    src.onLayer(layer("b", 5, 2));
    await p;
    expect(src.get("a", 5)).toBeNull();
    expect(src.get("b", 5)).not.toBeNull();
    expect(src.failureFor("a")).toEqual({ phase: "render", message: "timed out after 2 s", time: 5 / 30, frame: 5 });
    expect(src.failureFor("b")).toBeUndefined();
  });

  it("names the budget that ran out: a first render times out after the 5 s load budget (fix round 1, ruling 2)", async () => {
    const post = vi.fn(() => 1);
    const src = new ExportLayerSource(post, { reloadAll: async () => {} });
    const p = src.settle([req("a", 5)], at(5));
    src.onTimeout("a", "render", 5000);
    src.onRestart();
    await p;
    expect(src.failureFor("a")).toEqual({ phase: "render", message: "timed out after 5 s", time: 5 / 30, frame: 5 });
  });

  it("a restart abandons the render in flight — not a failure: it is posted again once the worker is back, and the rest follow", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post, { reloadAll: async () => {} });
    const p = src.settle([req("a", 5), req("b", 5)], at(5));
    src.onRestart();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toMatchObject({ id: "a", frame: 5 });
    src.onLayer(layer("a", 5, 1)); // the abandoned render's late answer: closed, not drawn
    expect(src.get("a", 5)).toBeNull();
    src.onLayer(layer("a", 5, 2));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    src.onLayer(layer("b", 5, 3));
    await p;
    expect(src.get("a", 5)).not.toBeNull();
    expect(src.get("b", 5)).not.toBeNull();
    expect(src.failures.size).toBe(0);
  });

  it("a restart that never comes does not hang the export: the wait is bounded", async () => {
    vi.useFakeTimers();
    try {
      const post = stubPost();
      const src = new ExportLayerSource(post, { restartWaitMs: 1000 });
      const p = src.settle([req("a", 5), req("b", 5)], at(5));
      src.onTimeout("a", "render");
      // "b" was abandoned; after the bound it is posted again and the sandbox refuses (-1).
      post.mockImplementation(() => -1);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(src.failureFor("b")?.message).toMatch(/did not load/);
      // …and it reaches the agent too, not only droppedOverlays (review minor 3).
      expect(src.failures.get("b")).toEqual({ phase: "build", message: "the overlay runtime did not load this body" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a request the sandbox refuses (-1: not loaded / dropped) settles at once, blaming the recorded load failure", async () => {
    const src = new ExportLayerSource(vi.fn(() => -1));
    src.onError({ t: "error", nonce: "n", id: "a", phase: "compile", sourceHash: "h", message: "Unexpected token" });
    await src.settle([req("a", 0), req("b", 0)], at(0));
    expect(src.get("a", 0)).toBeNull();
    expect(src.failureFor("a")).toEqual({ phase: "compile", message: "Unexpected token" });
    expect(src.failureFor("b")).toEqual({ phase: "build", message: "the overlay runtime did not load this body" });
  });

  it("a load failure is forgotten once the body renders cleanly (a boot failure that a restart recovered)", async () => {
    const src = new ExportLayerSource(stubPost());
    src.onError({ t: "error", nonce: "n", id: "a", phase: "build", message: "the overlay runtime could not start" });
    const p = src.settle([req("a", 0)], at(0));
    src.onLayer(layer("a", 0, 1));
    await p;
    expect(src.failures.has("a")).toBe(false);
  });

  it("an async escape (render error answering no request) is recorded but does not end the render in flight", async () => {
    const src = new ExportLayerSource(stubPost());
    const p = src.settle([req("a", 0)], at(0));
    src.onError({ t: "error", nonce: "n", id: "a", phase: "render", message: "late throw" });
    let done = false;
    void p.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    src.onLayer(layer("a", 0, 1));
    await p;
    expect(src.get("a", 0)).not.toBeNull();
    expect(src.failureFor("a")).toBeUndefined();
    expect(src.failures.get("a")).toEqual({ phase: "render", message: "late throw" });
  });

  it("a layer answering a request it did not post is closed, not drawn", async () => {
    const src = new ExportLayerSource(stubPost());
    const p = src.settle([req("a", 0)], at(0));
    const stray = bmp();
    src.onLayer(layer("a", 0, 99, stray));
    expect(stray.close).toHaveBeenCalled();
    src.onLayer(layer("a", 0, 1));
    await p;
  });

  it("records the composition frames each overlay rendered cleanly, as ranges", async () => {
    const src = new ExportLayerSource(stubPost());
    let r = 0;
    for (const f of [0, 1, 2, 4]) {
      const p = src.settle([req("a", f)], at(f));
      r++;
      if (f === 2) src.onError({ t: "error", nonce: "n", id: "a", phase: "render", req: r, message: "boom" });
      else src.onLayer(layer("a", f, r));
      await p;
    }
    expect(src.cleanFrames.get("a")).toEqual([[0, 2], [4, 5]]);
  });

  it("unattributed diagnostics are kept once per message, newest last, bounded", () => {
    const src = new ExportLayerSource(stubPost());
    src.onUnattributed({ t: "unattributed", nonce: "n", message: "a" });
    src.onUnattributed({ t: "unattributed", nonce: "n", message: "b", line: 1 });
    src.onUnattributed({ t: "unattributed", nonce: "n", message: "a" });
    expect(src.unattributed.map((u) => u.message)).toEqual(["b", "a"]);
    for (let i = 0; i < 30; i++) src.onUnattributed({ t: "unattributed", nonce: "n", message: `m${i}` });
    expect(src.unattributed).toHaveLength(10);
  });

  it("dispose closes every bitmap and releases anything still waiting", async () => {
    const src = new ExportLayerSource(stubPost());
    const p1 = src.settle([req("a", 0)], at(0));
    const b = bmp();
    src.onLayer(layer("a", 0, 1, b));
    await p1;
    const p2 = src.settle([req("b", 1)], at(1));
    src.dispose();
    await p2;
    expect(b.close).toHaveBeenCalled();
  });
});

describe("ExportLayerSource — Task 10 review minors", () => {
  it("an overlay that is no longer requested lets go of its bitmap at the next settle (minor 1)", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post);
    const p1 = src.settle([req("a", 0), req("b", 0)], at(0));
    const ba = bmp();
    src.onLayer(layer("a", 0, 1, ba));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    src.onLayer(layer("b", 0, 2));
    await p1;
    // "a" has ended: frame 1 asks only for "b".
    const p2 = src.settle([req("b", 1)], at(1));
    src.onLayer(layer("b", 1, 3));
    await p2;
    expect(ba.close).toHaveBeenCalled();
    expect(src.get("a", 0)).toBeNull();
    expect(src.get("b", 1)).not.toBeNull();
  });

  it("a render refused because the body never loaded is recorded for the agent, once, and kept behind a real load failure (minor 3)", async () => {
    const src = new ExportLayerSource(vi.fn(() => -1));
    src.onError({ t: "error", nonce: "n", id: "b", phase: "compile", sourceHash: "h", message: "Unexpected token" });
    await src.settle([req("a", 0), req("b", 0)], at(0));
    await src.settle([req("a", 1), req("b", 1)], at(1));
    expect(src.failures.get("a")).toEqual({ phase: "build", message: "the overlay runtime did not load this body" });
    expect(src.failures.get("b")).toEqual({ phase: "compile", message: "Unexpected token" });
  });

  it("an overlay given up on after repeated restarts is recorded for the agent, with the frame's time (minor 3)", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post, { reloadAll: async () => {} });
    const p = src.settle([req("a", 6)], at(6));
    for (let n = 1; n <= 3; n++) {
      await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(n));
      src.onRestart();
    }
    await p;
    expect(src.failureFor("a")).toEqual({ phase: "render", message: "the overlay runtime restarted repeatedly while rendering this frame" });
    expect(src.failures.get("a")).toEqual({ phase: "render", message: "the overlay runtime restarted repeatedly while rendering this frame", time: 6 / 30, frame: 6 });
  });

  it("a boot failure keeps its real reason: the load timeout that follows it does not overwrite it (minor 4)", () => {
    const src = new ExportLayerSource(stubPost());
    // What OverlaySandbox.handleSupervisorError sends, in this order.
    src.onError({ t: "error", nonce: "n", id: "a", phase: "build", message: "the overlay runtime could not start" });
    src.onTimeout("a", "load");
    expect(src.failures.get("a")).toEqual({ phase: "build", message: "the overlay runtime could not start" });
    // With nothing recorded first, the timeout is the reason.
    src.onTimeout("b", "load");
    expect(src.failures.get("b")).toEqual({ phase: "build", message: "timed out after 5 s" });
    src.dispose();
  });

  it("sameLayerRequest lives with LayerRequest; the preview re-exports the same function (minor 8)", () => {
    expect(previewSameLayerRequest).toBe(sameLayerRequest);
    expect(sameLayerRequest(req("a", 1), req("a", 1))).toBe(true);
    expect(sameLayerRequest(req("a", 1), req("a", 1, { pad: { left: 1, top: 0, right: 0, bottom: 0 } }))).toBe(false);
  });
});

describe("buildExportDiagnosticsReport", () => {
  it("names each failure's kind and source hash, carries clean frames, and caps a body-sized message", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post);
    const p = src.settle([req("a", 3), req("b", 3, { kind: "three" })], at(3));
    src.onError({ t: "error", nonce: "n", id: "a", phase: "render", req: 1, message: "x".repeat(5000), line: 1, column: 7 });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    src.onLayer(layer("b", 3, 2));
    await p;
    src.onUnattributed({ t: "unattributed", nonce: "n", message: "refused" });
    const report = buildExportDiagnosticsReport(
      src,
      new Map([
        ["a", { kind: "code" as const, sourceHash: "ha" }],
        ["b", { kind: "three" as const, sourceHash: "hb" }],
      ]),
      { fps: 30, now: 1234 },
    );
    expect(report.fps).toBe(30);
    expect(report.diagnostics).toEqual([
      { overlayId: "a", kind: "code", phase: "render", message: "x".repeat(4000), line: 1, column: 7, time: 0.1, frame: 3, sourceHash: "ha", at: 1234 },
    ]);
    expect(report.clean).toEqual([{ overlayId: "b", sourceHash: "hb", frames: [[3, 4]] }]);
    expect(report.unattributed).toEqual([{ message: "refused", at: 1234 }]);
  });
});

describe("a failure names its own frame (Task 12b re-review 2, N1)", () => {
  it("reports the absolute frame beside the ms-rounded time — frame 2 at 30 fps is 0.067, which alone reads as frame 3", async () => {
    const post = stubPost();
    const src = new ExportLayerSource(post);
    const p = src.settle([req("a", 2)], at(2));
    src.onError({ t: "error", nonce: "n", id: "a", phase: "render", req: 1, message: "boom" });
    await p;
    const report = buildExportDiagnosticsReport(src, new Map([["a", { kind: "code" as const, sourceHash: "ha" }]]), { fps: 30, now: 1 });
    expect(report.diagnostics).toEqual([
      { overlayId: "a", kind: "code", phase: "render", message: "boom", time: 0.067, frame: 2, sourceHash: "ha", at: 1 },
    ]);
  });
});

/**
 * Task 10 review, Important 1. The worker renders one body at a time, and the
 * host arms each render's 2 s watchdog when it POSTS it. Posting a frame's
 * renders all at once therefore charged every overlay for the time it spent
 * queued behind its siblings: three legitimate ~900 ms bodies in one frame and
 * the third "timed out after 2 s", was dropped for the rest of the export and
 * restarted the worker. Real host, real source, wired as render-entry.ts wires
 * them; the fake worker is serial, like the real one.
 */
describe("ExportLayerSource + OverlaySandbox — each watchdog measures only its own render", () => {
  const HASH = "c".repeat(64);
  const RENDER_MS = 900;

  function serialWorkerSandbox() {
    const renders: string[] = [];
    let busy = false;
    const queue: Array<{ id: string; frame: number; req: number }> = [];
    let deliver: (data: unknown) => void = () => {};
    const port = {
      postMessage(msg: { t: string; id: string; sourceHash?: string; frame?: number; req?: number }) {
        if (msg.t === "load") {
          setTimeout(() => deliver({ t: "loaded", nonce: "n", id: msg.id, sourceHash: msg.sourceHash }), 0);
        } else if (msg.t === "render") {
          queue.push({ id: msg.id, frame: msg.frame!, req: msg.req! });
          pump();
        }
      },
      close() {},
      start() {},
      onmessage: null as ((ev: { data: unknown }) => void) | null,
    };
    deliver = (data) => port.onmessage?.({ data });
    function pump() {
      if (busy) return;
      const next = queue.shift();
      if (!next) return;
      busy = true;
      setTimeout(() => {
        busy = false;
        renders.push(next.id);
        deliver({ t: "layer", nonce: "n", id: next.id, frame: next.frame, req: next.req, bitmap: bmp() });
        pump();
      }, RENDER_MS);
    }
    let reply: (data: unknown, source: unknown) => void = () => {};
    const peer = { frame: true };
    const commands: string[] = [];
    let source: ExportLayerSource | null = null;
    const timeouts: string[] = [];
    const restarts: number[] = [];
    const sandbox = new OverlaySandbox({
      nonce: () => "n",
      createTransport: () => ({
        command: (c) => commands.push(c.t),
        onReply: (h) => { reply = h; },
        peer,
        destroy() {},
      }),
      onLayer: (m) => (source ? source.onLayer(m) : m.bitmap.close()),
      onError: (m) => source?.onError(m),
      onTimeout: (id, phase) => { timeouts.push(`${id}:${phase}`); source?.onTimeout(id, phase); },
      onRestart: () => { restarts.push(1); source?.onRestart(); },
    });
    reply({ t: "ready", nonce: "n", version: PROTOCOL_VERSION, port }, peer);
    source = new ExportLayerSource((input) => sandbox.render(input));
    return { sandbox, source, renders, commands, timeouts, restarts };
  }

  it("three ~900 ms bodies in one frame all render: no timeout, no restart, nothing dropped", async () => {
    vi.useFakeTimers();
    try {
      const { sandbox, source, renders, commands, timeouts, restarts } = serialWorkerSandbox();
      const ids = ["a", "b", "c"];
      const loads = Promise.all(ids.map((id) => sandbox.load({ id, kind: "code", source: "x", sourceHash: HASH, width: 10, height: 10 })));
      await vi.advanceTimersByTimeAsync(0);
      await loads;
      const settled = source.settle(ids.map((id) => req(id, 4)), at(4));
      await vi.advanceTimersByTimeAsync(3 * RENDER_MS + 100);
      await settled;
      expect(timeouts).toEqual([]);
      expect(restarts).toEqual([]);
      expect(commands).not.toContain("restart");
      expect(renders).toEqual(ids);
      for (const id of ids) {
        expect(source.failureFor(id)).toBeUndefined();
        expect(source.get(id, 4)).not.toBeNull();
        expect(sandbox.isDropped(id)).toBe(false);
      }
      expect(source.failures.size).toBe(0);
      sandbox.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
