// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

const setPreviewTimelineZoom = vi.fn();
let storedZoom: number | null = null;
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    previewTimelineZoom: storedZoom,
    setPreviewTimelineZoom,
  }),
}));

// jsdom has no ResizeObserver. The Timeline now runs TWO observers (horizontal
// viewport width + vertical stack height). Key the reported size by the
// observed element's data-testid: the track-stack reports STACK_HEIGHT; the
// scroll viewport reports VIEWPORT_WIDTH.
const VIEWPORT_WIDTH = 1000;
let stackHeight = 400;
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    const testid = el.getAttribute("data-testid");
    const rect =
      testid === "timeline-track-stack"
        ? { width: VIEWPORT_WIDTH, height: stackHeight }
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
  stackHeight = 400;
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
import { TRACK_H_TALL, TRACK_H_SHORT } from "@/lib/preview/track-stack-view-model";
import type { Composition } from "@/lib/engine/types";

function renderTimeline() {
  const frameStore = createFrameStore();
  const selectionStore = createSelectionStore();
  const composition = {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [{ id: "s1", name: "Base", type: "video", duration: 3, fileId: "f1" }],
    overlays: [
      {
        id: "cap1",
        kind: "text",
        group: "captions",
        startTime: 0,
        duration: 1,
        z: 0,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        text: "hi",
      },
      {
        id: "stk1",
        kind: "image",
        group: "stickers",
        startTime: 0,
        duration: 1,
        z: 1,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        fileId: "img1",
      },
    ],
    audioClips: [{ id: "a1", kind: "standalone", fileId: "aud1", startTime: 0, duration: 2 }],
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
        audioClips={composition.audioClips}
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
}

function px(el: HTMLElement): number {
  return parseFloat(el.style.height);
}

describe("Timeline per-kind row heights", () => {
  it("all media tracks render TALL (fixed); text/audio SHORT; nothing stretches to fill", () => {
    renderTimeline();
    const captions = screen.getByTestId("overlay-lane-captions"); // text → SHORT
    const stickers = screen.getByTestId("overlay-lane-stickers"); // media overlay → TALL
    const audio = screen.getByTestId("timeline-audio-section");

    // Fixed per-kind heights: media (TALL) > text (SHORT).
    expect(px(stickers)).toBe(TRACK_H_TALL);
    expect(px(captions)).toBe(TRACK_H_SHORT);
    expect(px(stickers)).toBeGreaterThan(px(captions));
    // Audio is SHORT-tier (fixed) and does NOT grow.
    expect(px(audio)).toBeLessThan(TRACK_H_TALL);
    // Nothing absorbs the panel's leftover space — every row reports weight 0,
    // so the stack's total height stays below the panel it sits in.
    expect(px(stickers) + px(captions) + px(audio)).toBeLessThan(stackHeight);
  });

  it("keeps the fixed per-kind heights even when the stack is too short to grow", () => {
    stackHeight = 40; // far below minSum → no leftover
    renderTimeline();
    const captions = screen.getByTestId("overlay-lane-captions");
    const stickers = screen.getByTestId("overlay-lane-stickers");
    const audio = screen.getByTestId("timeline-audio-section");
    // Overlay/audio rows are fixed (weight 0) → unchanged by available space.
    expect(px(captions)).toBe(TRACK_H_SHORT);
    expect(px(stickers)).toBe(TRACK_H_TALL);
    expect(px(audio)).toBeLessThan(TRACK_H_TALL); // SHORT-tier, fixed
    expect(px(audio)).toBeGreaterThanOrEqual(TRACK_H_SHORT);
  });
});
