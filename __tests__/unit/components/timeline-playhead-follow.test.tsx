// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { maxPxPerSec } from "@/lib/preview/timeline-zoom";

// This fixture's composition + Timeline `fps` prop are both 30 (declared as
// FPS further down) — kept in sync with that value here rather than the
// module's own FPS constant so this assignment (evaluated before FPS is
// declared) doesn't depend on declaration order.
const FIXTURE_FPS = 30;

// Timeline reads viewMode + zoom from useEditorState. Stub it so we control the
// stored zoom (needed to blow the content lane past the viewport — the follow
// effect is a no-op when everything fits) without needing a provider. Mirrors
// timeline-zoom-layout.test.tsx's mocking approach.
const setPreviewTimelineZoom = vi.fn();
let storedZoom: number | null = maxPxPerSec(FIXTURE_FPS); // well past fit for this composition
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
    setPreviewTimelineZoom,
  }),
}));

// jsdom has no ResizeObserver. This fake immediately reports a fixed viewport
// width to the observed element's callback so the Timeline can compute fit.
// It also remembers every instance + the element it observed, so a test can
// simulate a LATER resize (a real panel-narrowing) by re-invoking a specific
// instance's callback directly — something a one-shot fake can't do.
const VIEWPORT_WIDTH = 1000;
let roInstances: FakeResizeObserver[] = [];
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  target: Element | null = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    roInstances.push(this);
  }
  observe(target: Element) {
    this.target = target;
    this.cb(
      [{ contentRect: { width: VIEWPORT_WIDTH, height: VIEWPORT_WIDTH } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
/** Re-fire a specific element's ResizeObserver callback with a new width —
 *  simulates the user narrowing the timeline panel after mount. */
function resizeElementTo(el: Element, width: number) {
  const inst = roInstances.find((i) => i.target === el);
  if (!inst) throw new Error("no ResizeObserver instance is watching this element");
  inst.cb([{ contentRect: { width } } as ResizeObserverEntry], inst as unknown as ResizeObserver);
}
beforeEach(() => {
  roInstances = [];
  storedZoom = maxPxPerSec(FIXTURE_FPS);
  setPreviewTimelineZoom.mockClear();
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
import { RAIL_WIDTH } from "@/components/preview/track-rail";
import { contentWidth as zoomContentWidth } from "@/lib/preview/timeline-zoom";
import { followScrollLeft, type FollowView } from "@/lib/preview/playhead-follow";

const TOTAL_FRAMES = 90;
const FPS = 30;

function renderTimeline() {
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
        onFrameChange={() => {}}
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
  return { frameStore };
}

/** The same renderWidth/viewportWidth/playheadX geometry Timeline computes
 *  internally for this fixed composition + storedZoom, used to derive the
 *  expected scrollLeft from the real `followScrollLeft` — never hand-picked. */
function expectedFollowScrollLeft(frame: number): number | null {
  const totalSeconds = TOTAL_FRAMES / FPS;
  const renderWidth = zoomContentWidth(storedZoom as number, totalSeconds); // storedZoom is well past fit
  const viewportWidth = VIEWPORT_WIDTH - RAIL_WIDTH;
  const playheadPercent = (frame / (TOTAL_FRAMES - 1)) * 100;
  const view: FollowView = {
    playheadX: (playheadPercent / 100) * renderWidth,
    scrollLeft: 0,
    viewportWidth,
    contentWidth: renderWidth,
  };
  return followScrollLeft(view);
}

describe("Timeline playhead-follow effect", () => {
  it("scrolls the container to bring an off-screen playhead back into view as the frame advances", () => {
    const { frameStore } = renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll") as HTMLDivElement;
    expect(scroll.scrollLeft).toBe(0);

    const targetFrame = TOTAL_FRAMES - 1; // far right — well outside the initial viewport
    const expected = expectedFollowScrollLeft(targetFrame);
    expect(expected).not.toBeNull(); // sanity: the scenario must actually need a scroll

    act(() => {
      frameStore.set(targetFrame);
    });

    expect(scroll.scrollLeft).toBe(expected);
  });

  it("does not scroll while the playhead is being dragged, leaving the edge auto-scroll in control", () => {
    const { frameStore } = renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll") as HTMLDivElement;
    const strip = screen.getByTestId("playhead-strip");

    // Latch the drag — this is the same surface use-playhead-scrub-edge.test.tsx
    // exercises at the hook level; here it drives Timeline's playheadDragging
    // state so the follow effect's guard is exercised through the real prop wiring.
    fireEvent.pointerDown(strip, { button: 0, clientX: 10, pointerId: 1 });
    expect(scroll.scrollLeft).toBe(0);

    const targetFrame = TOTAL_FRAMES - 1;
    // Off-screen by the same margin as the first test — if the guard were
    // missing, this would produce the same nonzero scrollLeft asserted there.
    expect(expectedFollowScrollLeft(targetFrame)).not.toBeNull();

    act(() => {
      frameStore.set(targetFrame);
    });

    expect(scroll.scrollLeft).toBe(0);
  });
});

describe("Timeline playhead-follow effect: re-follows on a viewport-width change (finding 3, constraint b)", () => {
  it("re-follows an off-screen playhead when the panel narrows, even though the frame did not change", () => {
    const { frameStore } = renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll") as HTMLDivElement;

    // Move the playhead off-screen once (paused), matching the first test in
    // this file, then manually scroll back to 0 — simulating the user having
    // scrolled away to look at something else. The follow effect must NOT
    // fight that manual scroll while nothing else changes (a bare re-render
    // must not re-follow just because it happened to run).
    const targetFrame = TOTAL_FRAMES - 1;
    act(() => {
      frameStore.set(targetFrame);
    });
    expect(scroll.scrollLeft).not.toBe(0); // sanity: the frame-change follow already fired
    act(() => {
      scroll.scrollLeft = 0;
    });
    expect(scroll.scrollLeft).toBe(0);

    // Now narrow the panel — same frame, but a real viewportWidth change. The
    // guard that fixes finding 3 must distinguish this from a zoom-only
    // (content-width) change and still follow: this is the exact behavior the
    // review said a naive `[currentFrame]`-only dep array would have broken.
    const NARROWED_BOX_WIDTH = 700;
    act(() => {
      resizeElementTo(scroll, NARROWED_BOX_WIDTH);
    });

    const narrowedViewportWidth = NARROWED_BOX_WIDTH - RAIL_WIDTH;
    const renderWidth = zoomContentWidth(storedZoom as number, TOTAL_FRAMES / FPS);
    const playheadPercent = (targetFrame / (TOTAL_FRAMES - 1)) * 100; // 100 — last frame
    const expected = followScrollLeft({
      playheadX: (playheadPercent / 100) * renderWidth,
      scrollLeft: 0,
      viewportWidth: narrowedViewportWidth,
      contentWidth: renderWidth,
    });
    expect(expected).not.toBeNull(); // sanity: the narrowed panel must actually need a scroll

    expect(scroll.scrollLeft).toBe(expected);
  });
});
