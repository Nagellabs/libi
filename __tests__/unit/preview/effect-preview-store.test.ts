import { describe, it, expect, vi } from "vitest";
import { createEffectPreviewStore } from "@/lib/preview/effect-preview-store";

describe("createEffectPreviewStore", () => {
  it("starts empty", () => {
    expect(createEffectPreviewStore().get()).toBeNull();
  });

  it("request() sets the window and bumps a monotonic nonce", () => {
    const s = createEffectPreviewStore();
    s.request({ startSec: 1, endSec: 2 });
    expect(s.get()).toEqual({ nonce: 1, startSec: 1, endSec: 2 });
    s.request({ startSec: 1, endSec: 2 }); // identical window
    expect(s.get()).toEqual({ nonce: 2, startSec: 1, endSec: 2 }); // nonce still advances
  });

  it("notifies subscribers on each request (even identical) and stops after unsubscribe", () => {
    const s = createEffectPreviewStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    s.request({ startSec: 0, endSec: 1 });
    s.request({ startSec: 0, endSec: 1 });
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    s.request({ startSec: 0, endSec: 1 });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
