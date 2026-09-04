// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";

// Timeline reads zoom from useEditorState. Unlike the other Timeline test
// files, THIS mock is backed by a real `useState` call — the regression under
// test (finding 3) only shows up once a Cmd/Ctrl+wheel zoom's
// `setPreviewTimelineZoom(next)` call actually flows back into a re-render
// with a new `previewTimelineZoom`, which a plain vi.fn() spy can't produce.
// Calling `useState` here works because this factory runs AS Timeline's own
// hook call (React attaches the state to Timeline's fiber), not as a
// standalone component.
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => {
    const [previewTimelineZoom, setPreviewTimelineZoom] = useState<number | null>(null);
    return { viewMode: "draft", previewTimelineZoom, setPreviewTimelineZoom };
  },
}));

const VIEWPORT_WIDTH = 1000;
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    this.cb(
      [{ contentRect: { width: VIEWPORT_WIDTH, height: VIEWPORT_WIDTH } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
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

import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";
import { RAIL_WIDTH } from "@/components/preview/track-rail";
import { fitPxPerSec, applyWheelZoom, anchoredScrollLeft, maxPxPerSec } from "@/lib/preview/timeline-zoom";

const TOTAL_FRAMES = 90;
const FPS = 30;
const TOTAL_SECONDS = TOTAL_FRAMES / FPS; // 3

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
  return screen.getByTestId("timeline-scroll") as HTMLDivElement;
}

describe("Timeline: anchored zoom vs. the playhead-follow effect (finding 3)", () => {
  it("keeps the anchored scrollLeft after a Cmd+wheel zoom when the playhead is outside the anchored window", () => {
    const scroll = renderTimeline();
    expect(scroll.scrollLeft).toBe(0);

    // Mount starts at Fit (previewTimelineZoom is null): the whole 3s
    // composition exactly fills the 972px (post-rail) viewport.
    const viewportWidth = VIEWPORT_WIDTH - RAIL_WIDTH;
    const oldPx = fitPxPerSec(viewportWidth, TOTAL_SECONDS);

    // Cmd+wheel zoom-in at clientX 900 — the same reproduction the reviewer
    // used (90 frames @30fps, 1000px panel, playhead at frame 0). The wheel
    // listener is a native, non-passive `addEventListener` (React's onWheel
    // can't preventDefault), so a real DOM `wheel` event is required here —
    // calling a handler prop directly wouldn't exercise the listener wiring.
    const clientX = 900;
    fireEvent.wheel(scroll, { deltaY: -100, ctrlKey: true, clientX });

    // Expected scrollLeft computed from the SAME pure functions Timeline's
    // wheel handler calls — never hand-picked — so this test tracks the real
    // zoom model instead of a snapshot of today's arithmetic.
    const newPx = applyWheelZoom({ pxPerSec: oldPx, factor: 1.1, maxPx: maxPxPerSec(FPS) });
    const pointerX = clientX - RAIL_WIDTH; // scrollRef's rect.left is 0 in jsdom
    const expectedAnchored = anchoredScrollLeft({
      pointerX,
      prevScrollLeft: 0,
      oldPxPerSec: oldPx,
      newPxPerSec: newPx,
    });

    // Sanity: the playhead (frame 0, x=0) must actually land OUTSIDE the
    // anchored window for this to exercise the regression at all — otherwise
    // the follow effect and the anchor would coincidentally agree.
    expect(expectedAnchored).toBeGreaterThan(0);

    // Before the fix, the follow effect's deps re-fired on this same
    // `renderWidth` change (via `readFollowView`) right after the `[cw]`
    // layout effect applied the anchor, saw the playhead (x=0) outside
    // [expectedAnchored, expectedAnchored + viewportWidth], and reset
    // scrollLeft to bring frame 0 back into view instead.
    expect(scroll.scrollLeft).toBe(expectedAnchored);
  });
});
