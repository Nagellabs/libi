// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Timeline reads viewMode + zoom from useEditorState. Stub it so we control the
// stored zoom and avoid needing a provider.
const setPreviewTimelineZoom = vi.fn();
let storedZoom: number | null = 500;
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
    setPreviewTimelineZoom,
  }),
}));

// jsdom has no ResizeObserver. This fake immediately reports a fixed viewport
// width to the observed element's callback so the Timeline can compute fit.
const VIEWPORT_WIDTH = 1000;
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    this.cb(
      [{ contentRect: { width: VIEWPORT_WIDTH } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  storedZoom = 500;
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

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";
import { contentWidth } from "@/lib/preview/timeline-zoom";
import { RAIL_WIDTH } from "@/components/preview/track-rail";

function renderTimeline() {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      { id: "s1", name: "Base", type: "video", duration: 2, fileId: "f1" },
      { id: "s2", name: "Outro", type: "canvas", duration: 1, drawFunction: "" },
    ],
    overlays: [
      {
        id: "o1",
        kind: "text",
        startTime: 0,
        duration: 1,
        z: 0,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        text: "hi",
      },
    ],
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
      overlays={composition.overlays}
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
  return { selectionStore };
}

describe("Timeline zoom layout", () => {
  it("renders the content lane at contentWidth (zoom decoupled from viewport)", () => {
    // totalSeconds = 90/30 = 3. fit = 1000/3 ≈ 333. storedZoom 500 ≥ fit.
    // cw = 500 * 3 = 1500. Scroll content width = RAIL_WIDTH + cw.
    const expectedCw = contentWidth(500, 3);
    renderTimeline();
    const content = screen.getByTestId("timeline-scroll-content");
    expect(content.style.width).toBe(`${RAIL_WIDTH + expectedCw}px`);
  });

  it("clamps zoom up to fit when stored zoom is below fit", () => {
    storedZoom = 10; // below fit
    renderTimeline();
    // At Fit the render width is PINNED to the measured post-rail viewport
    // (VIEWPORT_WIDTH - RAIL_WIDTH), not contentWidth(fit, …) — that's the
    // Plan-D fit-clamp that kills the phantom 1px horizontal scrollbar.
    const expectedRenderWidth = VIEWPORT_WIDTH - RAIL_WIDTH;
    const content = screen.getByTestId("timeline-scroll-content");
    expect(content.style.width).toBe(`${RAIL_WIDTH + expectedRenderWidth}px`);
  });

  it("keeps the track rails sticky at the left edge", () => {
    renderTimeline();
    const rail = screen.getByTestId("track-rail-Text");
    expect(rail).toHaveStyle({ position: "sticky", left: "0px" });
  });

  it("wraps the playhead strip + track stack in one horizontal scroll container", () => {
    renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll");
    expect(scroll).toBeInTheDocument();
    // both the ruler lane and the track stack live inside it
    expect(scroll.querySelector('[data-testid="playhead-strip"]')).not.toBeNull();
    expect(scroll.querySelector('[data-testid="timeline-track-stack"]')).not.toBeNull();
  });
});
