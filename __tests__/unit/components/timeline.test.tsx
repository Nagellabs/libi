// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// The timeline reads viewMode for the snapshot-gated "+ Add" picker. Stub the
// hook so it can render outside an EditorStateProvider.
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ viewMode: "draft", previewTimelineZoom: null, setPreviewTimelineZoom: vi.fn() }),
}));

// jsdom has no ResizeObserver — stub it so the timeline's useEffect doesn't throw.
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    // Report a fixed 1000px box so renderWidth > 0 and the playhead line renders.
    this.cb(
      [{ contentRect: { width: 1000, height: 400 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // Filmstrip status poll — return idle so nothing paints.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "idle", filename: null, frames: null, height: null, generatedAt: null }),
    })),
  );
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";

// Timeline calls useFilmstripStatuses (Plan C media-in-bars). Provide a client.
function qcWrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function setup() {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920, height: 1080, fps: 30,
    scenes: [
      { id: "s1", name: "Base video — ride", type: "video", duration: 2, fileId: "f1" },
      { id: "s2", name: "Outro", type: "canvas", duration: 1, drawFunction: "" },
    ],
    overlays: [
      { id: "o1", kind: "text", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, text: "hi" },
    ],
    audioClips: [],
  } as unknown as Composition;
  return { frameStore, selectionStore, composition };
}

describe("Timeline (track stack)", () => {
  it("renders an overlay row and no scrubber/legend, and no Video track at all", () => {
    const { frameStore, selectionStore, composition } = setup();
    qcWrap(
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
        durationSec={10}
        frameSize={{ width: 1920, height: 1080 }}
        onDropCreate={() => {}}
        onDropFiles={() => {}}
      />,
    );
    expect(screen.queryByTestId("timeline-video-track")).toBeNull();
    expect(screen.getByTestId("playhead-strip")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-lane-captions")).toBeInTheDocument();
    // Old scrubber-bar testid is gone.
    expect(screen.queryByTestId("timeline-track")).toBeNull();
  });

  it("spanning playhead line is grabbable and scrubs on pointerdown", () => {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    const onFrameChange = vi.fn();
    const { frameStore, selectionStore, composition } = setup();
    qcWrap(
      <Timeline
        totalFrames={90}
        frameStore={frameStore}
        fps={30}
        onFrameChange={onFrameChange}
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
        durationSec={10}
        frameSize={{ width: 1920, height: 1080 }}
        onDropCreate={() => {}}
        onDropFiles={() => {}}
      />,
    );
    const line = screen.getByTestId("timeline-playhead");
    expect(line.className).toContain("cursor-ew-resize");
    // jsdom rects are 0-width → degenerate mapping seeks frame 0.
    fireEvent.pointerDown(line, { clientX: 0, pointerId: 1 });
    expect(onFrameChange).toHaveBeenCalledWith(0);
  });
});
