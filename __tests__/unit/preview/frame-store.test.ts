import { describe, it, expect, vi } from "vitest";
import { createFrameStore } from "@/lib/preview/frame-store";

describe("createFrameStore", () => {
  it("starts at the initial frame (default 0)", () => {
    expect(createFrameStore().get()).toBe(0);
    expect(createFrameStore(12).get()).toBe(12);
  });

  it("set() updates the value and notifies subscribers", () => {
    const store = createFrameStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(5);
    expect(store.get()).toBe(5);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("set() with the same value does NOT notify (no redundant re-renders)", () => {
    const store = createFrameStore(3);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(3);
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    const store = createFrameStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    unsub();
    store.set(9);
    expect(cb).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const store = createFrameStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a listener that unsubscribes itself during notify does not break the set() pass and is silent thereafter", () => {
    // useSyncExternalStore (concurrent React) can drop a subscription while a
    // notify is in flight. Removing a listener mid-iteration must not throw and
    // must not skip the OTHER listener subscribed after it.
    const store = createFrameStore();
    let unsubA: () => void = () => {};
    const a = vi.fn(() => unsubA()); // unsubscribes itself when notified
    const b = vi.fn();
    unsubA = store.subscribe(a);
    store.subscribe(b);

    expect(() => store.set(1)).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1); // not skipped by a's self-removal

    // a is now gone; a later change notifies only b.
    store.set(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
