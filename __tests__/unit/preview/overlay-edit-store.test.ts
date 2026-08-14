import { describe, it, expect, vi } from "vitest";
import { createOverlayEditStore } from "@/lib/preview/overlay-edit-store";

describe("OverlayEditStore (phased, two-channel)", () => {
  it("preview() fires ONLY the imperative channel, never React", () => {
    const s = createOverlayEditStore();
    const react = vi.fn(); const imp = vi.fn();
    s.subscribe(react); s.subscribeImperative(imp);
    s.preview("o1", { rect: { x: 1, y: 2, width: 3, height: 4 } } as never);
    expect(imp).toHaveBeenCalledTimes(1);
    expect(react).not.toHaveBeenCalled();
    const e = s.getAll().get("o1")!;
    expect(e.phase).toBe("preview");
    expect(s.getCommitted().has("o1")).toBe(false); // not visible to React yet
  });

  it("preview() merges successive patches", () => {
    const s = createOverlayEditStore();
    s.preview("o1", { rotation: 10 } as never);
    s.preview("o1", { opacity: 0.5 } as never);
    expect(s.getAll().get("o1")!.patch).toMatchObject({ rotation: 10, opacity: 0.5 });
  });

  it("commit() flips phase->committed, bumps version, fires BOTH channels", () => {
    const s = createOverlayEditStore();
    const react = vi.fn(); const imp = vi.fn();
    s.preview("o1", { rotation: 10 } as never);
    s.subscribe(react); s.subscribeImperative(imp);
    const v = s.commit("o1", { rotation: 20 } as never);
    expect(v).toBe(2); // preview bumped to 1, commit to 2
    const e = s.getAll().get("o1")!;
    expect(e.phase).toBe("committed");
    expect(e.patch).toMatchObject({ rotation: 20 });
    expect(s.getCommitted().has("o1")).toBe(true); // now React-visible
    expect(react).toHaveBeenCalledTimes(1);
    expect(imp).toHaveBeenCalledTimes(1);
  });

  it("commit() with no prior preview creates a committed entry", () => {
    const s = createOverlayEditStore();
    const v = s.commit("o1", { rotation: 5 } as never);
    expect(v).toBe(1);
    expect(s.getCommitted().get("o1")!.patch).toMatchObject({ rotation: 5 });
  });

  it("confirm() drops a committed entry iff serverVersion >= entry.version", () => {
    const s = createOverlayEditStore();
    s.commit("o1", { rotation: 5 } as never); // version 1
    s.confirm("o1", 0); expect(s.getCommitted().has("o1")).toBe(true);  // stale, keep
    s.confirm("o1", 1); expect(s.getCommitted().has("o1")).toBe(false); // drop
  });

  it("confirm() never drops a preview entry", () => {
    const s = createOverlayEditStore();
    s.preview("o1", { rotation: 5 } as never);
    s.confirm("o1", 99);
    expect(s.getAll().has("o1")).toBe(true);
  });

  it("cancelPreview() drops a preview + fires imperative only", () => {
    const s = createOverlayEditStore();
    const react = vi.fn(); const imp = vi.fn();
    s.preview("o1", { rotation: 5 } as never);
    s.subscribe(react); s.subscribeImperative(imp);
    s.cancelPreview("o1");
    expect(s.getAll().has("o1")).toBe(false);
    expect(imp).toHaveBeenCalledTimes(1);
    expect(react).not.toHaveBeenCalled();
  });

  it("getAll partitions: includes both phases; getCommitted only committed", () => {
    const s = createOverlayEditStore();
    s.preview("p", { rotation: 1 } as never);
    s.commit("c", { rotation: 2 } as never);
    expect([...s.getAll().keys()].sort()).toEqual(["c", "p"]);
    expect([...s.getCommitted().keys()]).toEqual(["c"]);
  });

  it("with a scheduler, repeated preview() coalesces imperative fires into one", () => {
    let scheduled: (() => void) | null = null;
    const scheduler = (cb: () => void) => { scheduled = cb; };
    const s = createOverlayEditStore({ scheduler });
    const imp = vi.fn();
    s.subscribeImperative(imp);
    s.preview("o1", { rotation: 1 } as never);
    s.preview("o1", { rotation: 2 } as never);
    s.preview("o1", { rotation: 3 } as never);
    expect(imp).not.toHaveBeenCalled();      // nothing fired yet — coalesced
    scheduled!();                            // flush the frame
    expect(imp).toHaveBeenCalledTimes(1);    // exactly one imperative repaint
    expect(s.getAll().get("o1")!.patch).toMatchObject({ rotation: 3 });
  });
});
