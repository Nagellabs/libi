// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock useEditorState so we control viewMode (the snapshot gate). The panel
// already consumes the other fields it needs via props, so a minimal stub is
// enough — only viewMode is read for the Add gate.
let mockViewMode: "draft" | "snapshot" = "draft";
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ viewMode: mockViewMode }),
}));

// jsdom has no ResizeObserver — stub it so any measuring child doesn't throw.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

vi.mock("@/lib/queries/effects", () => ({
  useApplyLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearReveal: () => ({ mutate: vi.fn(), isPending: false }),
}));

// OverlayInspectorBody now reads caption styles via React Query — stub it so the
// inspector renders without a QueryClientProvider (falls back to bundled styles).
vi.mock("@/lib/queries/caption-styles", () => ({
  useCaptionStyles: () => ({ data: undefined }),
}));

import LayersInspectorPanel from "@/components/preview/layers-inspector-panel";
import { createSelectionStore } from "@/lib/preview/selection-store";
import { createHighlightStore } from "@/lib/preview/highlight-store";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import type { Composition } from "@/lib/engine/types";

const composition = {
  width: 1920, height: 1080, fps: 30,
  scenes: [
    { id: "s1", name: "Base video — ride", type: "video", duration: 2, fileId: "f1" },
  ],
  overlays: [
    { id: "o1", kind: "text", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, text: "hi" },
  ],
  audioClips: [],
} as unknown as Composition;

const files = [
  { id: "f1", name: "ride.mp4", filename: "ride.mp4", mediaWidth: 1920, mediaHeight: 1080, proxyStatus: "idle", proxyFilename: null, proxyHeight: null },
] as never;

function renderPanel() {
  const selectionStore = createSelectionStore(null);
  const frameStore = createFrameStore();
  render(
    <LayersInspectorPanel
      composition={composition}
      selectionStore={selectionStore}
      highlightStore={createHighlightStore()}
      frameStore={frameStore}
      files={files}
      previewQuality="auto"
      isOverlayLocked={() => false}
      onToggleLocked={() => {}}
      onCommit={() => {}}
      pieceId="p1"
      resolveCtx={() => ({ startTime: 0, width: 1920, height: 1080, z: 1, totalDuration: 30 })}
      onCreateDirect={() => {}}
      onPickAsset={() => {}}
      onAskAgent={() => {}}
      effectHighlightStore={createEffectHighlightStore()}
      onOpenEffects={() => {}}
      effectsReadOnly={false}
    />,
  );
}

describe("LayersInspectorPanel + Add", () => {
  it("shows + Add in draft view", () => {
    mockViewMode = "draft";
    renderPanel();
    expect(screen.getByText("Add")).toBeInTheDocument();
  });

  it("hides + Add in snapshot view", () => {
    mockViewMode = "snapshot";
    renderPanel();
    expect(screen.queryByText("Add")).toBeNull();
  });
});
