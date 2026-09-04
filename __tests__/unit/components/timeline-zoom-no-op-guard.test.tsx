// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { maxPxPerSec } from "@/lib/preview/timeline-zoom";

// This composition renders at 30fps below (both in `composition.fps` and the
// `fps` prop), so its ceiling is `maxPxPerSec(30)`.
const FPS = 30;
const MAX_PX = maxPxPerSec(FPS);

// Fixed AT the zoom ceiling: `applyWheelZoom` clamps a zoom-in step at this
// value back to itself, so `handleZoomTo` must treat it as a no-op (finding
// 5) rather than arming a pending anchor no later width change will consume.
const setPreviewTimelineZoom = vi.fn();
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: MAX_PX,
    setPreviewTimelineZoom,
  }),
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

import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";

function renderTimeline() {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [{ id: "s1", name: "Base", type: "video", duration: 3, fileId: "f1" }],
    overlays: [],
    audioClips: [],
  } as unknown as Composition;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <Timeline
        totalFrames={90}
        frameStore={frameStore}
        fps={30}
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
}

describe("Timeline handleZoomTo no-op guard (finding 5)", () => {
  it("does not call setPreviewTimelineZoom when zoom-in clamps to the current value at the frame-derived ceiling", () => {
    renderTimeline();
    // Mount itself fires the piece-change fit-reset effect
    // (setPreviewTimelineZoom(null)) — isolate the click's own call.
    setPreviewTimelineZoom.mockClear();
    fireEvent.click(screen.getByTestId("zoom-in"));
    // Before the fix, handleZoomTo armed `pendingAnchorRef` and called
    // setPreviewTimelineZoom(next) unconditionally even when
    // `next === pxPerSec` — a no-op zoom that still left a pending anchor
    // for some LATER width change to apply against a stale scroll position.
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
  });
});
