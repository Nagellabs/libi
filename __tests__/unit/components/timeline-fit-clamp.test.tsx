// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Timeline reads viewMode + zoom from useEditorState. Stub it so we control the
// stored zoom and avoid needing a provider.
const setPreviewTimelineZoom = vi.fn();
let storedZoom: number | null = null;
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
    setPreviewTimelineZoom,
  }),
}));

// jsdom has no ResizeObserver. The Timeline now has TWO ResizeObservers (the
// horizontal scroll viewport + the vertical track-stack height). Key the
// reported size by the observed element's data-testid so each observer gets a
// sensible measurement: the scroll viewport reports VIEWPORT_WIDTH; the stack
// reports a tall height so rows distribute (irrelevant here but keeps it sane).
const VIEWPORT_WIDTH = 1000;
const STACK_HEIGHT = 400;
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    const testid = el.getAttribute("data-testid");
    const rect =
      testid === "timeline-track-stack"
        ? { width: VIEWPORT_WIDTH, height: STACK_HEIGHT }
        : { width: VIEWPORT_WIDTH, height: 0 };
    this.cb(
      [{ contentRect: rect } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  storedZoom = null;
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
        scenes={[{ id: "s1", name: "Base", duration: 3 }]}
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
        onSceneContextMenu={() => {}}
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

describe("Timeline fit-clamp (no horizontal scrollbar at Fit)", () => {
  it("pins the scroll-content width to the measured viewport at Fit", () => {
    storedZoom = null; // Fit
    renderTimeline();
    const content = screen.getByTestId("timeline-scroll-content");
    // viewport = VIEWPORT_WIDTH - RAIL_WIDTH; at Fit the content width is pinned
    // to the viewport exactly (NOT contentWidth(fit, …) which can float to
    // viewport + ε and trigger a 1px scrollbar).
    expect(content.style.width).toBe(`${RAIL_WIDTH + (VIEWPORT_WIDTH - RAIL_WIDTH)}px`);
  });

  it("hides horizontal overflow at Fit", () => {
    storedZoom = null; // Fit
    renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll");
    expect(scroll.style.overflowX).toBe("hidden");
  });

  it("uses auto overflow and contentWidth when zoomed past Fit", () => {
    storedZoom = 500; // well above fit (fit ≈ 972/3 ≈ 324)
    renderTimeline();
    const scroll = screen.getByTestId("timeline-scroll");
    expect(scroll.style.overflowX).toBe("auto");
    const content = screen.getByTestId("timeline-scroll-content");
    expect(content.style.width).toBe(`${RAIL_WIDTH + contentWidth(500, 3)}px`);
  });
});
