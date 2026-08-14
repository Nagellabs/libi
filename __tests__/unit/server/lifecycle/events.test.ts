import { describe, it, expect, beforeEach } from "vitest";
import { lifecycleEvents, __resetLifecycleEventsForTests } from "@/lib/server/lifecycle/events";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";

describe("lifecycleEvents", () => {
  beforeEach(() => __resetLifecycleEventsForTests());

  it("dispatches events to subscribers", () => {
    const seen: LifecycleEvent[] = [];
    const off = lifecycleEvents.on((e) => seen.push(e));
    lifecycleEvents.emit({ kind: "prelude-start" });
    lifecycleEvents.emit({ kind: "category-a-done", durationMs: 42 });
    expect(seen).toEqual([
      { kind: "prelude-start" },
      { kind: "category-a-done", durationMs: 42 },
    ]);
    off();
    lifecycleEvents.emit({ kind: "prelude-start" });
    expect(seen).toHaveLength(2);
  });

  it("isolates subscribers — one throwing does not stop the others", () => {
    const seen: LifecycleEvent[] = [];
    lifecycleEvents.on(() => {
      throw new Error("boom");
    });
    lifecycleEvents.on((e) => seen.push(e));
    expect(() =>
      lifecycleEvents.emit({ kind: "category-a-done", durationMs: 42 }),
    ).not.toThrow();
    expect(seen).toEqual([{ kind: "category-a-done", durationMs: 42 }]);
  });
});
