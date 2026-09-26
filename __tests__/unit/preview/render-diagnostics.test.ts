import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRenderDiagnosticsStore } from "@/lib/preview/render-diagnostics";
import {
  MAX_DIAGNOSTICS_PER_PIECE,
  MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_UNATTRIBUTED_PER_PIECE,
  UNATTRIBUTED_TTL_MS,
} from "@/lib/render/render-diagnostics-types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const empty = { diagnostics: [], unattributed: [] };

describe("createRenderDiagnosticsStore (client, debounced PUT — spec §4.7)", () => {
  it("syncs once on creation, so a reopened preview replaces what the server still holds", async () => {
    const put = vi.fn(async () => {});
    createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 300 });
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(put).toHaveBeenCalledExactlyOnceWith("p1", empty);
  });
  it("keeps the latest diagnostic per overlay and PUTs the whole set once per debounce window", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 300, now: () => 42 });
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "first" });
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "second", line: 2 });
    store.report({ overlayId: "b", kind: "three", phase: "build", message: "b" });
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("p1", {
      diagnostics: [
        { overlayId: "a", kind: "code", phase: "render", message: "second", line: 2, at: 42 },
        { overlayId: "b", kind: "three", phase: "build", message: "b", at: 42 },
      ],
      unattributed: [],
    });
  });
  it("clear removes an overlay and PUTs the (possibly empty) set", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => 1 });
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "x" });
    await vi.advanceTimersByTimeAsync(10);
    store.clear("a");
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenLastCalledWith("p1", empty);
    expect(store.snapshot()).toEqual([]);
  });
  it("clear of an unknown overlay is a no-op (no PUT beyond the initial sync)", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    store.clear("nobody");
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it("clearUnattributed withdraws an unpositioned entry and PUTs the set without it; an unknown one is a no-op (R2-M1)", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => 1 });
    store.reportUnattributed({ message: "still starting" });
    store.reportUnattributed({ message: "a font did not install" });
    await vi.advanceTimersByTimeAsync(10);
    store.clearUnattributed("still starting");
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenLastCalledWith("p1", { diagnostics: [], unattributed: [{ message: "a font did not install", at: 1 }] });
    const calls = put.mock.calls.length;
    store.clearUnattributed("still starting");
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenCalledTimes(calls);
  });
  it("a failed PUT never throws into the caller", async () => {
    const put = vi.fn(async () => { throw new Error("offline"); });
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10 });
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "x" });
    // A rejection escaping the timer callback would fail the run as unhandled.
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenCalledTimes(1);
    await expect(store.flush()).resolves.toBeUndefined();
  });
  it("unattributed diagnostics ride the same PUT, deduped by message+position, latest `at` kept", async () => {
    const put = vi.fn(async () => {});
    let t = 100;
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => t });
    store.reportUnattributed({ message: "Refused to connect" });
    t = 200;
    store.reportUnattributed({ message: "Refused to connect" });
    store.reportUnattributed({ message: "font X failed", line: 3, column: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenLastCalledWith("p1", {
      diagnostics: [],
      unattributed: [
        { message: "Refused to connect", at: 200 },
        { message: "font X failed", line: 3, column: 1, at: 200 },
      ],
    });
  });
  it("the unattributed map is capped AT INSERT, in count and entry size — a burst of unique reports never grows it (final review I1)", async () => {
    const put = vi.fn(async () => {});
    let t = 0;
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 300, now: () => ++t });
    // What a flood that got past every other limit would hand the store:
    // 20,000 unique reports, each far past the message cap, inside one
    // debounce window (the TTL prune only runs when a payload is built).
    for (let i = 0; i < 20_000; i++) store.reportUnattributed({ message: `x${i} ${"…".repeat(9_000)}` });
    const kept = store.snapshotUnattributed();
    expect(kept).toHaveLength(MAX_UNATTRIBUTED_PER_PIECE);
    expect(kept.every((u) => u.message.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS)).toBe(true);
    // The newest are what is kept, oldest first.
    expect(kept.at(-1)!.message.startsWith("x19999 ")).toBe(true);
    expect(kept[0]!.message.startsWith(`x${20_000 - MAX_UNATTRIBUTED_PER_PIECE} `)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    const sent = (put.mock.lastCall as unknown as [string, { unattributed: unknown[] }])[1];
    expect(sent.unattributed).toHaveLength(MAX_UNATTRIBUTED_PER_PIECE);
    // A per-overlay report is held to the same size.
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "y".repeat(50_000) });
    expect(store.snapshot()[0]!.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });
  it("unattributed entries past the TTL are dropped from the next PUT", async () => {
    const put = vi.fn(async () => {});
    let t = 0;
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => t });
    store.reportUnattributed({ message: "old" });
    t = UNATTRIBUTED_TTL_MS + 1;
    store.reportUnattributed({ message: "new" });
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenLastCalledWith("p1", { diagnostics: [], unattributed: [{ message: "new", at: t }] });
  });
  it("never sends more than the route accepts: compile/build first, then the newest render errors (Task 11 fix I2)", async () => {
    const put = vi.fn(async () => {});
    let t = 0;
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => ++t });
    // The compile errors are the OLDEST — priority, not recency, keeps them.
    for (let i = 0; i < 3; i++) store.report({ overlayId: `c${i}`, kind: "code", phase: "compile", message: "Unexpected token" });
    store.report({ overlayId: "b0", kind: "three", phase: "build", message: "THREE is not defined" });
    for (let i = 0; i < 60; i++) store.report({ overlayId: `r${i}`, kind: "code", phase: "render", message: "boom", time: i / 30 });
    await vi.advanceTimersByTimeAsync(10);
    const sent = (put.mock.calls.at(-1) as unknown as [string, { diagnostics: Array<{ overlayId: string; phase: string; at: number }> }])[1].diagnostics;
    expect(sent).toHaveLength(MAX_DIAGNOSTICS_PER_PIECE);
    expect(sent.slice(0, 4).map((d) => d.phase)).toEqual(["build", "compile", "compile", "compile"]);
    const renderIds = sent.filter((d) => d.phase === "render").map((d) => d.overlayId);
    expect(renderIds).toHaveLength(MAX_DIAGNOSTICS_PER_PIECE - 4);
    expect(renderIds[0]).toBe("r59"); // newest first
    expect(renderIds).not.toContain("r0");
    // The store itself keeps them all: a cleared one frees a slot for the next.
    expect(store.snapshot()).toHaveLength(64);
  });
  it("carries a render error's failing time and frame", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 10, now: () => 3 });
    store.report({ overlayId: "a", kind: "code", phase: "render", message: "x", time: 2.5, frame: 75 });
    await vi.advanceTimersByTimeAsync(10);
    expect(put).toHaveBeenLastCalledWith("p1", { diagnostics: [{ overlayId: "a", kind: "code", phase: "render", message: "x", time: 2.5, frame: 75, at: 3 }], unattributed: [] });
  });
  it("dispose sends a pending change instead of losing it, then goes quiet", async () => {
    const put = vi.fn(async () => {});
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put, debounceMs: 300, now: () => 7 });
    store.report({ overlayId: "a", kind: "code", phase: "compile", message: "Unexpected token" });
    store.dispose();
    expect(put).toHaveBeenCalledExactlyOnceWith("p1", {
      diagnostics: [{ overlayId: "a", kind: "code", phase: "compile", message: "Unexpected token", at: 7 }],
      unattributed: [],
    });
    store.report({ overlayId: "b", kind: "code", phase: "render", message: "late" });
    await vi.advanceTimersByTimeAsync(300);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("the client store's bundle (Task 11 fix M3)", () => {
  it("imports its shapes from the shared types module, never the server store (its Maps and zod stay out of the browser)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../../lib/preview/render-diagnostics.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/render-diagnostics-store/);
    expect(src).not.toMatch(/from "zod/);
    expect(src).toMatch(/@\/lib\/render\/render-diagnostics-types/);
  });
});
