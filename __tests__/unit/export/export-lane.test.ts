// __tests__/unit/export/export-lane.test.ts
//
// D2–D4 review I2: one export encodes at a time, and a user's export never
// waits behind a background example render. Foreground exports (the user's
// `export` job, a publish preparation) are served in arrival order; a
// background render starts only while none runs or waits, at most one at a
// time, and yields — its signal aborts — the moment a foreground one arrives.
import { describe, expect, it } from "vitest";
import { ExportLane, isBackgroundYield } from "@/lib/export/export-lane";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ExportLane", () => {
  it("a foreground export starts at once on an idle lane; the next one waits its turn (FIFO)", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const order: string[] = [];
    const a = await lane.foreground();
    order.push("a");
    const bP = lane.foreground().then((r) => (order.push("b"), r));
    const cP = lane.foreground().then((r) => (order.push("c"), r));
    await tick();
    expect(order).toEqual(["a"]);
    a();
    const b = await bP;
    await tick();
    expect(order).toEqual(["a", "b"]);
    b();
    (await cP)();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a background render waits while a foreground export runs, and starts once it is done", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const fg = await lane.foreground();
    let started = false;
    const bgP = lane.background().then((s) => ((started = true), s));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    fg();
    const bg = await bgP;
    expect(started).toBe(true);
    expect(bg.signal.aborted).toBe(false);
    bg.release();
  });

  it("a foreground export arriving mid-render makes the background render yield, and starts as soon as it let go", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const events: string[] = [];
    const bg = await lane.background();
    bg.signal.addEventListener("abort", () => events.push("bg aborted"));
    const fgP = lane.foreground().then((release) => (events.push("user export starts"), release));
    await tick();
    // Told to stop at once — but the user's export never overlaps the render's encoder.
    expect(events).toEqual(["bg aborted"]);
    expect(isBackgroundYield(bg.signal.reason)).toBe(true);
    events.push("bg let go");
    bg.release();
    const fg = await fgP;
    expect(events).toEqual(["bg aborted", "bg let go", "user export starts"]);
    // The render asks again: it waits for the user's export to finish.
    let again = false;
    const bg2P = lane.background().then((s) => ((again = true), s));
    await new Promise((r) => setTimeout(r, 20));
    expect(again).toBe(false);
    fg();
    (await bg2P).release();
    expect(again).toBe(true);
  });

  it("at most one background render at a time", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const first = await lane.background();
    let second = false;
    const p = lane.background().then((s) => ((second = true), s));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    first.release();
    (await p).release();
    expect(second).toBe(true);
  });

  it("a background render also waits while `busy` says a user export is queued elsewhere (the export job's own slot)", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    let queued = true;
    let started = false;
    const p = lane.background({ busy: () => queued }).then((s) => ((started = true), s));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    queued = false;
    (await p).release();
    expect(started).toBe(true);
  });

  it("a waiting background render stops waiting when its own job is cancelled", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const fg = await lane.foreground();
    const ac = new AbortController();
    const p = lane.background({ signal: ac.signal });
    ac.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow(/cancelled/);
    fg();
    // The lane is not left held by the abandoned wait.
    (await lane.background()).release();
  });

  it("release is idempotent", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const fg = await lane.foreground();
    fg();
    fg();
    const again = await lane.foreground();
    const other = lane.foreground();
    let got = false;
    void other.then(() => (got = true));
    await tick();
    expect(got).toBe(false);
    again();
    (await other)();
  });

  it("a foreground waiter whose job is cancelled leaves the queue at once, holding no place (fix-round review N2)", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const holder = await lane.foreground();
    const ac = new AbortController();
    const cancelled = lane.foreground({ signal: ac.signal });
    const next = lane.foreground();
    let nextGot = false;
    void next.then(() => (nextGot = true));
    ac.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow(/cancelled/);
    holder();
    // The next waiter is handed the lane directly — the cancelled one took no turn.
    await tick();
    expect(nextGot).toBe(true);
    (await next)();
    await expect(lane.foreground({ signal: ac.signal })).rejects.toThrow(/cancelled/);
  });

  it("a cancel while a yielding background render tears down ends the wait at once, and hands the lane on (final review F8)", async () => {
    const lane = new ExportLane({ pollMs: 5 });
    const bg = await lane.background(); // never lets go: a hung teardown
    const ac = new AbortController();
    const waiting = lane.foreground({ signal: ac.signal });
    await tick();
    expect(bg.signal.aborted).toBe(true);
    expect(lane.foregroundBusy()).toBe(true);
    ac.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(lane.foregroundBusy()).toBe(false);
    bg.release();
    (await lane.foreground())();
  });
});
