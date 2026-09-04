// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Task 4 (commit 261cb4e1) added two effects to Timeline that both call
// setPreviewTimelineZoom(null): a piece-change fit reset, and a bare Shift+Z
// fit shortcut. Neither had a test — this file covers both directly against
// the mounted component, reusing the mocking approach from
// timeline-zoom-controls.test.tsx.
const setPreviewTimelineZoom = vi.fn();
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: null,
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

import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Timeline from "@/components/preview/timeline";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createSelectionStore } from "@/lib/preview/selection-store";
import type { Composition } from "@/lib/engine/types";

function renderTimeline(pieceId: string) {
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
  const ui = (id: string) => (
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
        pieceId={id}
        resolveCtx={() => ({ startTime: 0, width: 1920, height: 1080, z: 1, totalDuration: 30 })}
        onCreateDirect={() => {}}
        onPickAsset={() => {}}
        onAskAgent={() => {}}
        durationSec={3}
        frameSize={{ width: 1920, height: 1080 }}
        onDropCreate={() => {}}
        onDropFiles={() => {}}
      />
    </QueryClientProvider>
  );
  const result = render(ui(pieceId));
  return {
    rerenderWithPieceId: (id: string) => result.rerender(ui(id)),
  };
}

describe("Timeline piece-change fit reset", () => {
  it("re-renders with a CHANGED pieceId and calls setPreviewTimelineZoom(null)", () => {
    const { rerenderWithPieceId } = renderTimeline("piece-1");
    // Mount itself fires the effect once — isolate the rerender's own call.
    setPreviewTimelineZoom.mockClear();
    rerenderWithPieceId("piece-2");
    expect(setPreviewTimelineZoom).toHaveBeenCalledTimes(1);
    expect(setPreviewTimelineZoom).toHaveBeenCalledWith(null);
  });

  it("re-renders with the SAME pieceId and does not fire again", () => {
    const { rerenderWithPieceId } = renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    rerenderWithPieceId("piece-1");
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
  });
});

describe("Timeline Shift+Z fit shortcut", () => {
  it("fires setPreviewTimelineZoom(null) on a plain Shift+Z keydown", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    fireEvent.keyDown(document, { key: "z", shiftKey: true });
    expect(setPreviewTimelineZoom).toHaveBeenCalledTimes(1);
    expect(setPreviewTimelineZoom).toHaveBeenCalledWith(null);
  });

  it("also fires on the capital 'Z' the shift key produces", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    fireEvent.keyDown(document, { key: "Z", shiftKey: true });
    expect(setPreviewTimelineZoom).toHaveBeenCalledTimes(1);
    expect(setPreviewTimelineZoom).toHaveBeenCalledWith(null);
  });

  it("does not fire when focus is inside an <input>", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(document, { key: "z", shiftKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not fire when focus is inside a <textarea>", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(document, { key: "z", shiftKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
    document.body.removeChild(textarea);
  });

  it("does not fire when focus is inside a contenteditable element", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom doesn't compute isContentEditable from the attribute (no editing
    // host algorithm implemented) — stub the getter so the guard's check is
    // exercised the same way it would be in a real browser.
    Object.defineProperty(div, "isContentEditable", { value: true, configurable: true });
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    fireEvent.keyDown(document, { key: "z", shiftKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });

  it("does not fire when focus is inside a <select>", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    const select = document.createElement("select");
    document.body.appendChild(select);
    select.focus();
    fireEvent.keyDown(document, { key: "z", shiftKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
    document.body.removeChild(select);
  });

  it("does not fire when ctrlKey is held", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    fireEvent.keyDown(document, { key: "z", shiftKey: true, ctrlKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
  });

  it("does not fire when metaKey is held", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    fireEvent.keyDown(document, { key: "z", shiftKey: true, metaKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
  });

  it("does not fire when altKey is held", () => {
    renderTimeline("piece-1");
    setPreviewTimelineZoom.mockClear();
    fireEvent.keyDown(document, { key: "z", shiftKey: true, altKey: true });
    expect(setPreviewTimelineZoom).not.toHaveBeenCalled();
  });
});
