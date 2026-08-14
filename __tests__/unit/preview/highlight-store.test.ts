import { describe, it, expect, vi } from "vitest";
import {
  createHighlightStore,
  targetGroupForHighlight,
} from "@/lib/preview/highlight-store";
import { groupForField } from "@/lib/overlays/inspector-fields";

describe("createHighlightStore", () => {
  it("set then get returns the value", () => {
    const store = createHighlightStore();
    store.set({ overlayId: "ov1", property: "content", note: "edit me" });
    expect(store.get()).toEqual({ overlayId: "ov1", property: "content", note: "edit me" });
  });

  it("auto-clears after the injected TTL elapses", () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const setTimeoutFn = (fn: () => void, ms: number) => {
      const handle = { at: now + ms, fn };
      timers.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimeoutFn = (h: ReturnType<typeof setTimeout>) => {
      const i = timers.indexOf(h as unknown as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    };

    const store = createHighlightStore({ setTimeoutFn, clearTimeoutFn });
    store.set({ overlayId: "ov1", property: "content" }, 4000);
    expect(store.get()).not.toBeNull();

    advance(3999);
    expect(store.get()).not.toBeNull();

    advance(2);
    expect(store.get()).toBeNull();
  });

  it("notifies subscribers on set and on auto-clear", () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const setTimeoutFn = (fn: () => void, ms: number) => {
      const handle = { at: now + ms, fn };
      timers.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    };
    const store = createHighlightStore({ setTimeoutFn });
    const sub = vi.fn();
    store.subscribe(sub);
    store.set({ overlayId: "ov1", property: "content" }, 1000);
    expect(sub).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(sub).toHaveBeenCalledTimes(2);
    expect(store.get()).toBeNull();
  });
});

describe("targetGroupForHighlight", () => {
  it("returns the field's exact intent group for the targeted kind", () => {
    // "content" is in the text group for text.
    expect(targetGroupForHighlight("content", "text")).toBe("text");
    // "background.color" is in the style group for text.
    expect(targetGroupForHighlight("background.color", "text")).toBe("style");
    // "stroke" is in the style group for text.
    expect(targetGroupForHighlight("stroke", "text")).toBe("style");
    // in-plane placement keys are in the transform group for text.
    expect(targetGroupForHighlight("transformPosX", "text")).toBe("transform");
    // 3D rotation/extrusion keys are in the 3d group for text.
    expect(targetGroupForHighlight("transform3d.rotation", "text")).toBe("3d");
    expect(targetGroupForHighlight("text3dEnabled", "text")).toBe("3d");
  });

  it("resolves PLANAR placement keys to the transform group for every kind", () => {
    expect(targetGroupForHighlight("transformPosX", "code")).toBe("transform");
    expect(targetGroupForHighlight("transformPosX", "image")).toBe("transform");
    expect(targetGroupForHighlight("transformSpin", "image")).toBe("transform");
    // tracked has NO Position keys (placement is track-driven — reposition via
    // offsetX/offsetY); its Size (scale) / Spin stay on the transform tab.
    expect(groupForField("transformPosX", "tracked")).toBeUndefined();
    expect(targetGroupForHighlight("transformSize", "tracked")).toBe("transform");
    expect(targetGroupForHighlight("transformSpin", "tracked")).toBe("transform");
  });

  it("resolves SPATIAL keys (Pose/Rotation/Depth-Z) + place3d to the 3d group", () => {
    // Universal-3D: the out-of-plane keys live behind the place3d gate now. The
    // rotation dial (transform3d.rotation) + Pose grid replaced the per-axis
    // Angle/Elevation slider keys for the flat kinds' 3D tab.
    expect(targetGroupForHighlight("transform3d.rotation", "image")).toBe("3d");
    expect(targetGroupForHighlight("transform3d.pose", "video")).toBe("3d");
    expect(targetGroupForHighlight("transformPosZ", "code")).toBe("3d");
    expect(targetGroupForHighlight("place3d", "image")).toBe("3d");
    // tracked has no 3D tab — its follow-offset rows live on the (only) transform group.
    expect(targetGroupForHighlight("offsetX", "tracked")).toBe("transform");
    expect(targetGroupForHighlight("offsetY", "tracked")).toBe("transform");
  });

  it("falls back to the kind's default group for an unknown property", () => {
    // Text's default tab is now Text (the first canonical group); non-text
    // kinds only have Transform.
    expect(targetGroupForHighlight("does.not.exist", "text")).toBe("text");
    expect(targetGroupForHighlight("does.not.exist", "image")).toBe("transform");
  });

  it("falls back to the kind's default group when the key isn't applicable to the kind", () => {
    // "content" is text-only → not applicable to image → default (transform).
    expect(targetGroupForHighlight("content", "image")).toBe("transform");
  });
});
