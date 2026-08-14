// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The panel reads viewMode for the snapshot-gated "+ Add" picker. Stub the
// hook so the panel can render outside an EditorStateProvider. The active
// inspector tab is driven by `mockInspectorMode` so tests can flip tabs.
let mockInspectorMode = "transform";
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    // The Transform panel + Opacity live in the transform group for text.
    getOverlayInspectorMode: () => mockInspectorMode,
    setOverlayInspectorMode: vi.fn(),
    // The shared Transform-tab Size control reads the per-overlay W/H split
    // memory from editor-state; default non-split here.
    getOverlaySizeSplit: () => false,
    setOverlaySizeSplit: vi.fn(),
  }),
}));

vi.mock("@/lib/queries/effects", () => ({
  useApplyLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearReveal: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/queries/caption-styles", () => ({
  useCaptionStyles: () => ({ data: undefined }),
}));

// The Style tab renders <PresetRow>, which fetches presets via React Query.
// Stub the hooks so it renders outside a QueryClientProvider.
vi.mock("@/lib/queries/overlay-presets", () => ({
  useOverlayPresets: () => ({ data: [] }),
  useApplyPreset: () => ({ mutate: vi.fn(), isPending: false }),
  useSavePreset: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePreset: () => ({ mutate: vi.fn(), isPending: false }),
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
    { id: "s1", name: "Intro card", type: "canvas", duration: 2, drawFunction: "" },
    { id: "s2", name: "Outro", type: "canvas", duration: 1, drawFunction: "" },
  ],
  overlays: [
    { id: "o1", kind: "text", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, text: "hi" },
  ],
  audioClips: [],
} as unknown as Composition;

const files = [
  { id: "f1", name: "ride.mp4", filename: "ride.mp4", mediaWidth: 1920, mediaHeight: 1080, proxyStatus: "idle", proxyFilename: null, proxyHeight: null },
] as never;

function renderPanel(selectedId: string | null) {
  const selectionStore = createSelectionStore(selectedId);
  const highlightStore = createHighlightStore();
  const frameStore = createFrameStore();
  render(
    <LayersInspectorPanel
      composition={composition}
      selectionStore={selectionStore}
      highlightStore={highlightStore}
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
  return { selectionStore };
}

describe("LayersInspectorPanel", () => {
  beforeEach(() => {
    mockInspectorMode = "transform";
  });

  it("does not render the layers list (removed in A5 — selection now lives in the timeline)", () => {
    renderPanel(null);
    expect(screen.queryByTestId("layer-scene-row-s1")).toBeNull();
    expect(screen.queryByTestId("layer-row-o1")).toBeNull();
  });

  it("names the selected scene (canvas scenes carry no source-video card)", () => {
    renderPanel("s1");
    expect(screen.getByTestId("inspector-scene-name")).toHaveTextContent("Intro card");
    expect(screen.queryByText("ride.mp4")).toBeNull();
  });

  it("shows the transform inspector when an overlay is selected", () => {
    renderPanel("o1");
    // Text mounts the in-plane placement panel on its Transform tab (X/Y/Size +
    // a 2D rotate), plus the opacity control (data-field="opacity"). The 3D
    // rotation keys (transformAngle) now live on the 3D tab.
    expect(document.querySelector('[data-field="rotation"]')).not.toBeNull();
    expect(document.querySelector('[data-field="transformPosX"]')).not.toBeNull();
    expect(document.querySelector('[data-field="opacity"]')).not.toBeNull();
  });

  it("falls back to the playhead scene when nothing is selected", () => {
    renderPanel(null);
    // Frame 0 → scene s1.
    expect(screen.getByTestId("inspector-scene-name")).toHaveTextContent("Intro card");
  });

  it("renders the Effects sub-panel only on the Transform tab", () => {
    mockInspectorMode = "transform";
    renderPanel("o1");
    expect(screen.getByTestId("inspector-effects")).toBeInTheDocument();
  });

  it.each(["style", "text", "3d"])(
    "hides the Effects sub-panel on the %s tab",
    (tab) => {
      mockInspectorMode = tab;
      renderPanel("o1");
      expect(screen.queryByTestId("inspector-effects")).toBeNull();
    },
  );
});
