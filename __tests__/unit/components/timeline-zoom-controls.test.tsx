// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

const setPreviewTimelineZoom = vi.fn();
let storedZoom: number | null = 500;
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
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

import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";
import {
  applyWheelZoom,
  fitPxPerSec,
  zoomFactorPercent,
} from "@/lib/preview/timeline-zoom";
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

describe("Timeline zoom controls", () => {
  it("renders the four zoom controls", () => {
    renderTimeline();
    expect(screen.getByTestId("zoom-out")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-readout")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-fit")).toBeInTheDocument();
  });

  it("zoom-in calls setPreviewTimelineZoom with a larger px", () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(setPreviewTimelineZoom).toHaveBeenCalledTimes(1);
    const arg = setPreviewTimelineZoom.mock.calls[0][0] as number;
    expect(arg).toBeGreaterThan(500);
    expect(arg).toBeCloseTo(applyWheelZoom({ pxPerSec: 500, factor: 1.2 }));
  });

  it("zoom-out calls setPreviewTimelineZoom with a smaller px", () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("zoom-out"));
    const arg = setPreviewTimelineZoom.mock.calls[0][0] as number;
    expect(arg).toBeLessThan(500);
    expect(arg).toBeCloseTo(applyWheelZoom({ pxPerSec: 500, factor: 1 / 1.2 }));
  });

  it("zoom-fit calls setPreviewTimelineZoom(null)", () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("zoom-fit"));
    expect(setPreviewTimelineZoom).toHaveBeenCalledWith(null);
  });

  it("readout shows the zoom factor percent relative to fit", () => {
    renderTimeline();
    // viewport = VIEWPORT_WIDTH - RAIL_WIDTH; totalSeconds = 3.
    const fit = fitPxPerSec(VIEWPORT_WIDTH - RAIL_WIDTH, 3);
    const pct = zoomFactorPercent(500, fit);
    expect(screen.getByTestId("zoom-readout").textContent).toContain(String(pct));
  });
});
