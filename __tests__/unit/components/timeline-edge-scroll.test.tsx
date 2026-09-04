// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { maxPxPerSec } from "@/lib/preview/timeline-zoom";

// This fixture's composition + Timeline `fps` prop are both 30 (declared as
// FPS further down) — kept in sync with that value here rather than the
// module's own FPS constant so this assignment (evaluated before FPS is
// declared) doesn't depend on declaration order.
const FIXTURE_FPS = 30;

// Timeline reads viewMode + zoom from useEditorState. Fixed at the fps-derived
// zoom ceiling (well past fit) so there is scrollable content — the
// edge-scroll rAF loop is a no-op when everything already fits the viewport.
// Mirrors timeline-playhead-follow.test.tsx's mocking approach.
const setPreviewTimelineZoom = vi.fn();
const storedZoom = maxPxPerSec(FIXTURE_FPS);
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
    setPreviewTimelineZoom,
  }),
}));

// jsdom has no ResizeObserver. This fake immediately reports a fixed viewport
// width to the observed element's callback so the Timeline can compute fit.
// It also records which element each instance observes, and keeps every live
// instance in a module-level registry — `resizeElement` below uses that to
// find the ONE instance watching a specific element (Timeline creates three:
// the scroll viewport, the track stack, and one per track row) and fire a
// follow-up measurement, simulating a panel resize/splitter drag AFTER mount.
const VIEWPORT_WIDTH = 1000;
const liveResizeObservers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  target: Element | null = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    liveResizeObservers.push(this);
  }
  observe(target: Element) {
    this.target = target;
    this.cb(
      [{ contentRect: { width: VIEWPORT_WIDTH, height: VIEWPORT_WIDTH } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {
    this.target = null;
  }
}
/** Re-fire the ResizeObserver callback watching `target` with a new width —
 *  simulates a later panel resize (editor splitter drag, window resize)
 *  without a remount. */
function resizeElement(target: Element, width: number) {
  const ro = liveResizeObservers.find((o) => o.target === target);
  if (!ro) throw new Error("no live ResizeObserver is watching this element");
  ro.cb([{ contentRect: { width, height: width } } as ResizeObserverEntry], ro as unknown as ResizeObserver);
}
beforeEach(() => {
  setPreviewTimelineZoom.mockClear();
  liveResizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "idle", filename: null, frames: null, height: null, generatedAt: null }),
    })),
  );
});

import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";
import { contentWidth as zoomContentWidth } from "@/lib/preview/timeline-zoom";

const TOTAL_FRAMES = 90;
const FPS = 30;
const RENDER_WIDTH = zoomContentWidth(storedZoom, TOTAL_FRAMES / FPS); // 12000, matches storedZoom fixture

function renderTimeline(onFrameChange: (frame: number) => void = () => {}) {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920,
    height: 1080,
    fps: FPS,
    scenes: [{ id: "s1", name: "Base", type: "video", duration: 3, fileId: "f1" }],
    overlays: [],
    audioClips: [],
  } as unknown as Composition;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <Timeline
        totalFrames={TOTAL_FRAMES}
        frameStore={frameStore}
        fps={FPS}
        onFrameChange={onFrameChange}
        composition={composition}
        audioClips={[]}
        markers={[]}
        overlays={[]}
        selectionStore={selectionStore}
        isOverlayLocked={() => false}
        collapsedGroups={{}}
        onToggleRowCollapsed={() => {}}
        onCommitOverlayTiming={() => {}}
        onCrossRowOverlay={() => {}}
        pieceId="p1"
        resolveCtx={() => ({ startTime: 0, width: 1920, height: 1080, z: 1, totalDuration: 30 })}
        onCreateDirect={() => {}}
        onPickAsset={() => {}}
        onAskAgent={() => {}}
        durationSec={3}
        frameSize={{ width: 1920, height: 1080 }}
        onDropCreate={() => {}}
        onDropFiles={() => {}}
      />
    </QueryClientProvider>,
  );
  const scroll = screen.getByTestId("timeline-scroll") as HTMLDivElement;
  const strip = screen.getByTestId("playhead-strip") as HTMLDivElement;
  // jsdom gives every element a zeroed getBoundingClientRect. The lane's real
  // rect matters for frameFromClientX (used by the scrub callbacks), so stub
  // it to the geometry Timeline itself computed for this fixture.
  //
  // The strip lane is NOT sticky (only the rail spacer beside it is), so as
  // the ancestor `timeline-scroll` container's scrollLeft changes, the lane's
  // on-screen left edge moves by the same amount in the opposite direction —
  // exactly what real layout does. `left` is computed from `scroll.scrollLeft`
  // at CALL time (not captured once here) so it tracks every scroll the
  // edge-scroll loop itself performs. A fixed rect (the previous version of
  // this stub) makes both `usePlayheadScrub` instances that read it compute
  // the identical frame on every tick regardless of which one is asked —
  // which hides any divergence between their independent dedupe guards, i.e.
  // exactly the bug this suite needs to be able to see.
  strip.getBoundingClientRect = () => {
    const left = -scroll.scrollLeft;
    return {
      left,
      top: 0,
      width: RENDER_WIDTH,
      height: 14,
      right: left + RENDER_WIDTH,
      bottom: 14,
      x: left,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
  };
  return { frameStore, scroll, strip };
}

/** Pump N real animation frames, each wrapped in `act` so any resulting state
 *  update is flushed before the next one schedules. */
async function flushFrames(count: number) {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  }
}

describe("Timeline edge auto-scroll — the playhead pin/strip surface", () => {
  it("scrolls the lane while a strip/pin drag is held at the right edge", async () => {
    const { scroll, strip } = renderTimeline();
    expect(scroll.scrollLeft).toBe(0);

    // Start the drag away from either edge, then move to just inside the
    // right edge zone (EDGE_SCROLL_ZONE_PX = 24px from the visible right
    // edge of the 972px-wide viewport, post-rail).
    fireEvent.pointerDown(strip, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(strip, { buttons: 1, clientX: 990, pointerId: 1 });

    await flushFrames(6);

    // Before the fix, the strip's own `usePlayheadScrub` call never received
    // `onDragPointerX`, so `dragPointerXRef` stayed null and this rAF loop's
    // `tick()` returned on every frame — scrollLeft would remain 0 here.
    expect(scroll.scrollLeft).toBeGreaterThan(0);

    fireEvent.pointerUp(strip, { button: 0, clientX: 990, pointerId: 1 });
  });
});

describe("Timeline edge auto-scroll — stale pointer x across drags", () => {
  // Deliberately uses the SPANNING LINE surface (`timeline-playhead`), not the
  // strip — that keeps this test isolated from finding 1's fix (the line's
  // `usePlayheadScrub` already passed `onDragPointerX` before this branch, so
  // drag 1's auto-scroll here does not depend on the strip wiring at all).
  it("a fresh press elsewhere after an edge-zone drag does not spontaneously scroll or re-seek", async () => {
    const onFrameChange = vi.fn();
    const { scroll } = renderTimeline(onFrameChange);
    const line = screen.getByTestId("timeline-playhead");

    // Drag 1: ends inside the right edge zone, having driven some auto-scroll.
    fireEvent.pointerDown(line, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(line, { buttons: 1, clientX: 990, pointerId: 1 });
    await flushFrames(6);
    const scrolledDuringDrag1 = scroll.scrollLeft;
    expect(scrolledDuringDrag1).toBeGreaterThan(0); // sanity: drag 1 actually auto-scrolled

    fireEvent.pointerUp(line, { button: 0, clientX: 990, pointerId: 1 });
    await flushFrames(3); // let the drag-end effect cleanup (and, with the fix, the ref reset) settle

    const settledAfterDrag1 = scroll.scrollLeft;
    onFrameChange.mockClear();

    // A brand-new press, far from either edge — no pointermove follows it, so
    // (with the fix) dragPointerXRef has nothing to read and the loop is
    // inert. Before the fix, the stale clientX (990) from drag 1 was never
    // cleared, so this fresh drag's rAF loop read it immediately and kept
    // scrolling/re-seeking on its own — reproduced by the reviewer as
    // scrollLeft climbing 0→56 within ~80ms after a mid-lane press.
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 2 });
    await flushFrames(6);

    expect(scroll.scrollLeft).toBe(settledAfterDrag1);
    // The only seek after the fresh press must be the press's OWN pointerdown
    // seek (frame under clientX 300) — never a re-scrub to the stale 990.
    for (const call of onFrameChange.mock.calls) {
      expect(call[0]).not.toBe(Math.round((990 / RENDER_WIDTH) * (TOTAL_FRAMES - 1)));
    }

    fireEvent.pointerUp(line, { button: 0, clientX: 300, pointerId: 2 });
  });
});

describe("Timeline edge auto-scroll — cross-instance scrubTo dedupe", () => {
  // Both `usePlayheadScrub` instances (the strip's own, and the spanning
  // line's — the one this rAF loop always re-scrubs through) read the SAME
  // `laneRef` (`playheadLaneRef`, owned by the strip), so their computed
  // frame for a given clientX and lane rect is identical. But each
  // instance's `lastFrameRef` dedupe guard used to be private to that
  // instance, so a drag on the STRIP surface (the primary scrub gesture)
  // alternates between the strip's own dedupe state (advanced by its own
  // coalesced pointermove handling) and the line's (advanced only by this
  // loop's re-scrub) — landing both on the same target frame in one tick
  // but each guard seeing it as new, producing a duplicate `onFrameChange`
  // emission. A reviewer's probe (lane rect stubbed to move with
  // `scrollLeft`, as the fixture above now does) observed the emitted
  // sequence `[0, 7, 7, 8]` — frame 7 emitted twice.
  it("does not double-emit the frame the strip's own scrub and the edge-scroll re-scrub both land on", async () => {
    const onFrameChange = vi.fn();
    const { strip } = renderTimeline(onFrameChange);

    // Press near the left edge — seeks frame 0 through the STRIP's OWN
    // scrub, priming only the strip's dedupe guard. The line's guard has
    // never been touched (it starts at `null`).
    fireEvent.pointerDown(strip, { button: 0, clientX: 10, pointerId: 1 });
    expect(onFrameChange).toHaveBeenLastCalledWith(0);

    // Move into the right edge zone. This queues two independent rAF
    // callbacks for the very next frame: the edge-scroll loop's `tick()`
    // (already running since drag start; re-scrubs through the LINE's
    // `scrubTo`) and the strip's own coalesced-move callback (re-scrubs
    // through the STRIP's `scrubTo`) — both read the same clientX and,
    // after the tick's small scroll step, the same lane rect.
    fireEvent.pointerMove(strip, { buttons: 1, clientX: 990, pointerId: 1 });
    onFrameChange.mockClear();

    await flushFrames(1);

    // Before the fix: each instance's private guard independently accepts
    // this frame (the line's because it has never seen ANY frame yet, the
    // strip's because its guard was last primed at a different frame by the
    // initial press) — `onFrameChange` fires twice for the identical frame
    // number. With the shared guard, whichever callback runs first marks
    // the frame seen and the second is deduped, so every emitted frame in
    // this tick is distinct.
    const frames = onFrameChange.mock.calls.map((call) => call[0] as number);
    expect(frames.length).toBeGreaterThan(0); // sanity: the tick did emit something
    expect(new Set(frames).size).toBe(frames.length);

    fireEvent.pointerUp(strip, { button: 0, clientX: 990, pointerId: 1 });
  });
});

describe("Timeline edge auto-scroll — surviving a mid-drag panel resize", () => {
  // Reproduces: hold the pin stationary in the right edge zone while the
  // lane auto-scrolls, then something resizes the panel (an editor splitter
  // drag, a window resize) WITHOUT the pointer itself moving. The resize
  // changes `viewportWidth`, which re-arms the edge-scroll effect (its deps
  // include `viewportWidth`) — a teardown of the old effect instance
  // followed by a fresh setup. That re-arm must not touch `dragPointerXRef`:
  // with the pointer stationary, no pointermove will ever repopulate it, so
  // wiping it here kills edge auto-scroll silently for the rest of the drag.
  it("keeps auto-scrolling after a mid-drag viewport width change with no further pointer movement", async () => {
    const { scroll, strip } = renderTimeline();
    expect(scroll.scrollLeft).toBe(0);

    // Start the drag and move once into the right edge zone — after this,
    // the pointer never moves again for the rest of the test.
    fireEvent.pointerDown(strip, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(strip, { buttons: 1, clientX: 990, pointerId: 1 });

    await flushFrames(3);
    const scrolledBeforeResize = scroll.scrollLeft;
    expect(scrolledBeforeResize).toBeGreaterThan(0); // sanity: auto-scroll is active

    // Simulate a panel resize mid-drag (e.g. dragging the editor's vertical
    // splitter) — the viewport shrinks, but the pointer stays exactly where
    // it was. No pointermove follows this.
    act(() => {
      resizeElement(scroll, VIEWPORT_WIDTH - 200);
    });

    await flushFrames(3);

    // Before the fix, the re-arm nulled `dragPointerXRef` and nothing ever
    // repopulated it (the pointer didn't move) — scrollLeft would be frozen
    // at `scrolledBeforeResize` here, for the rest of the drag.
    expect(scroll.scrollLeft).toBeGreaterThan(scrolledBeforeResize);

    fireEvent.pointerUp(strip, { button: 0, clientX: 990, pointerId: 1 });
  });
});
