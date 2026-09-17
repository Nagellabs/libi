// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ viewMode: "draft", previewTimelineZoom: null, setPreviewTimelineZoom: vi.fn() }),
}));

class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe() {
    this.cb([{ contentRect: { width: 1000, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ status: "idle", filename: null, frames: null, height: null, generatedAt: null }),
  })));
});

import React from "react";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import { LIBI_FILE_MIME } from "@/lib/preview/drag-payload";
import type { Composition } from "@/lib/engine/types";

function qcWrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function renderTimeline() {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920, height: 1080, fps: 30,
    scenes: [],
    overlays: [
      { id: "o1", kind: "text", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, text: "hi" },
    ],
    audioClips: [],
  } as unknown as Composition;
  return qcWrap(
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
      onDropAudio={() => {}}
    />,
  );
}

/** jsdom drops `relatedTarget` from the fireEvent init bag for drag events, so
 *  set it on the constructed event directly. */
function fireDragLeave(relatedTarget: EventTarget | null) {
  const ev = createEvent.dragLeave(window);
  Object.defineProperty(ev, "relatedTarget", { value: relatedTarget });
  fireEvent(window, ev);
}

/** A dragover carrying a libi asset payload — what turns the strip on. */
function dragOverStack() {
  const stack = screen.getByTestId("timeline-track-stack");
  fireEvent.dragOver(stack, { dataTransfer: { types: [LIBI_FILE_MIME], dropEffect: "" } });
}

/**
 * The "＋ new track" strip is revealed by a drag and used to be hidden ONLY by
 * a drop on the strip itself, so every other ending — a drop on an existing
 * lane, or Escape — left it stranded on screen until the next reload. That is
 * what a real user hit after dragging a track onto a lane.
 */
describe("Timeline new-track dropzone lifecycle", () => {
  it("shows the strip while a file drag is over the timeline", () => {
    renderTimeline();
    expect(screen.queryByTestId("timeline-newtrack-zone")).toBeNull();
    dragOverStack();
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
  });

  it("hides the strip when a drop lands on a lane and bubbles to the stack", () => {
    renderTimeline();
    dragOverStack();
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
    // A lane's own onDrop does not stopPropagation, so the drop reaches the stack.
    fireEvent.drop(screen.getByTestId("timeline-track-stack"));
    expect(screen.queryByTestId("timeline-newtrack-zone")).toBeNull();
  });

  it("hides the strip when the drag is cancelled (dragend on the source)", () => {
    renderTimeline();
    dragOverStack();
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
    // dragend fires on the drag SOURCE — the resources panel, outside the
    // stack — so it is watched on the window.
    fireEvent.dragEnd(window);
    expect(screen.queryByTestId("timeline-newtrack-zone")).toBeNull();
  });

  // REGRESSION. Chromium fires dragleave with a NULL relatedTarget while the
  // pointer is still mid-drag inside the page. A window-level
  // `if (!e.relatedTarget) hide()` guard therefore fired on an ordinary drag
  // and the timeline stopped showing as a drop target at all. Measured in the
  // running app: 1 dragleave, relatedTarget null, strip visible before it and
  // gone after. Nothing may hide the strip on a dragleave alone.
  it("keeps the strip on a mid-drag dragleave carrying a null relatedTarget", () => {
    renderTimeline();
    dragOverStack();
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
    fireDragLeave(null);
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
  });

  // Same null-relatedTarget dragleave, but dispatched ON THE STACK, where the
  // component's own onDragLeave sees it. This is the one that actually broke
  // the strip in the running app.
  it("keeps the strip on a null-relatedTarget dragleave fired at the stack", () => {
    renderTimeline();
    dragOverStack();
    const stack = screen.getByTestId("timeline-track-stack");
    const ev = createEvent.dragLeave(stack);
    Object.defineProperty(ev, "relatedTarget", { value: null });
    fireEvent(stack, ev);
    expect(screen.getByTestId("timeline-newtrack-zone")).toBeInTheDocument();
  });

  it("hides the strip when the pointer moves to a named element outside the stack", () => {
    renderTimeline();
    dragOverStack();
    const stack = screen.getByTestId("timeline-track-stack");
    const ev = createEvent.dragLeave(stack);
    Object.defineProperty(ev, "relatedTarget", { value: document.body });
    fireEvent(stack, ev);
    expect(screen.queryByTestId("timeline-newtrack-zone")).toBeNull();
  });
});
