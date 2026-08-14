// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Inspector tab (intent group) the mock reports as active. `null` => the kind's
// default first tab (text → "text", everything else → "transform"), matching
// defaultGroupForKind. A test sets this to force a specific tab.
let mockModeOverride: string | null = null;
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    viewMode: "draft",
    getOverlayInspectorMode: (_p: string, _o: string, kind: string) =>
      mockModeOverride ?? (kind === "text" ? "text" : "transform"),
    setOverlayInspectorMode: vi.fn(),
    // The shared Transform-tab Size control (image/video/code/three) reads the
    // per-overlay W/H split memory from editor-state; default non-split here.
    getOverlaySizeSplit: () => false,
    setOverlaySizeSplit: vi.fn(),
  }),
}));

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

// CaptionInspector now mounts <PresetRow>, whose hooks call useQuery — stub them
// so the panel renders without a QueryClientProvider.
vi.mock("@/lib/queries/overlay-presets", () => ({
  useOverlayPresets: () => ({ data: [] }),
  useApplyPreset: () => ({ mutate: vi.fn() }),
  useSavePreset: () => ({ mutate: vi.fn() }),
  useDeletePreset: () => ({ mutate: vi.fn() }),
}));

import LayersInspectorPanel from "@/components/preview/layers-inspector-panel";
import { createSelectionStore } from "@/lib/preview/selection-store";
import { createHighlightStore } from "@/lib/preview/highlight-store";
import { createFrameStore } from "@/lib/preview/frame-store";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import type { Composition } from "@/lib/engine/types";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";

const composition = {
  width: 1920, height: 1080, fps: 30,
  scenes: [
    { id: "s1", name: "Base", type: "video", duration: 2, fileId: "f1" },
  ],
  overlays: [
    {
      id: "o1", kind: "text", startTime: 0, duration: 1, z: 0,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      content: "Hello",
      font: "24px Inter", color: "#fff", align: "left",
    },
    {
      id: "o2", kind: "three", startTime: 0, duration: 1, z: 1,
      rect: { x: 0, y: 0, width: 200, height: 200 },
      sceneFunction: "// scene",
    },
    {
      id: "o3", kind: "image", startTime: 0, duration: 1, z: 2,
      rect: { x: 0, y: 0, width: 320, height: 240 },
      fileId: "f2",
    },
  ],
  audioClips: [
    { id: "a1", kind: "inline", fileId: "f1", startTime: 0, duration: 2, trimStart: 0, volume: 0.8, enabled: true, linkedSceneId: "s1", label: "scene audio" },
  ],
} as unknown as Composition;

const files = [
  { id: "f1", name: "base.mp4", filename: "base.mp4", contentType: "video/mp4", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 2 },
  { id: "f2", name: "logo.png", filename: "logo.png", contentType: "image/png", mediaWidth: 512, mediaHeight: 512, mediaDuration: null },
] as never;

function renderPanel(selectedId: string | null = null, {
  onCommit,
  onToggleLocked,
  onTranscribeAudio,
  effectsReadOnly = false,
}: {
  onCommit?: (id: string, patch: OverlayTransformPatch) => void;
  onToggleLocked?: (id: string) => void;
  onTranscribeAudio?: (a: { fileId: string; fileName: string; label?: string }) => void;
  effectsReadOnly?: boolean;
} = {}) {
  const _onCommit = onCommit ?? vi.fn();
  const _onToggleLocked = onToggleLocked ?? vi.fn();
  const selectionStore = createSelectionStore(selectedId);
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
      onToggleLocked={_onToggleLocked}
      onCommit={_onCommit}
      pieceId="p1"
      resolveCtx={() => ({ startTime: 0, width: 1920, height: 1080, z: 1, totalDuration: 30 })}
      onCreateDirect={() => {}}
      onPickAsset={() => {}}
      onAskAgent={() => {}}
      onTranscribeAudio={onTranscribeAudio}
      effectHighlightStore={createEffectHighlightStore()}
      onOpenEffects={() => {}}
      effectsReadOnly={effectsReadOnly}
    />,
  );
  return { onCommit: _onCommit, onToggleLocked: _onToggleLocked };
}

describe("LayersInspectorPanel (A5: drop layers list + move hide/lock into inspector body)", () => {
  beforeEach(() => {
    mockModeOverride = null;
  });

  it("does NOT render the track select dropdown", () => {
    renderPanel();
    expect(screen.queryByTestId("inspector-track-select")).toBeNull();
  });

  it("does NOT render layer-row-* items", () => {
    renderPanel();
    expect(screen.queryByTestId("layer-row-o1")).toBeNull();
  });

  it("renders inspector-hide and inspector-lock buttons when an overlay is selected", () => {
    renderPanel("o1");
    expect(screen.getByTestId("inspector-hide")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-lock")).toBeInTheDocument();
  });

  it("read-only (snapshot) view: the eye is disabled and never commits a draft edit", () => {
    // Locked decision D3: toggling the eye is a REAL draft mutation, so the
    // read-only snapshot view must not allow it — the button is disabled and a
    // click can't reach onCommit (no accidental has_draft flip from snapshot).
    const { onCommit } = renderPanel("o1", { effectsReadOnly: true });
    const eye = screen.getByTestId("inspector-hide");
    expect(eye).toBeDisabled();
    fireEvent.click(eye);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the persisted hidden field when inspector-hide is clicked", () => {
    const { onCommit } = renderPanel("o1");
    fireEvent.click(screen.getByTestId("inspector-hide"));
    // o1 is visible (no hidden field) → the eye commits { hidden: true } via
    // the optimistic edit-store → PATCH path (a real draft edit).
    expect(onCommit).toHaveBeenCalledWith("o1", { hidden: true });
  });

  it("calls onToggleLocked when inspector-lock is clicked", () => {
    const { onToggleLocked } = renderPanel("o1");
    fireEvent.click(screen.getByTestId("inspector-lock"));
    expect(onToggleLocked).toHaveBeenCalledWith("o1");
  });

  it("renders the CaptionInspector when a text overlay is selected", () => {
    // Force the Transform tab: placement (the anchor pad) lives there. The text
    // overlay's default tab is now Text (content), so assert placement on the
    // Transform tab explicitly.
    mockModeOverride = "transform";
    renderPanel("o1");
    // The caption inspector mounts for text overlays; on the transform tab it
    // shows the placement controls (the anchor pad). Content lives on the Text tab.
    expect(screen.getByTestId("caption-inspector")).toBeInTheDocument();
    // The placement controls share the AnchorPad (data-testid="anchor-pad").
    expect(screen.getAllByTestId("anchor-pad").length).toBeGreaterThan(0);
  });

  it("renders the ThreeInspector when a three overlay is selected", () => {
    // Universal-3D: three now has Transform (2D rect) + 3D (scene transform)
    // tabs. The mock forces the Transform tab, so the gizmo fields
    // (camera/reset, registry group "3d") are gated out; the ThreeInspector
    // container still mounts and the 2D rect controls render on Transform. The
    // Transform tab uses AnchorPad + the SAME generic rect SizeField as
    // image/video/code (committing `{rect}`) — the old `scale` slider is gone.
    renderPanel("o2");
    expect(screen.getByTestId("three-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("anchor-pad")).toBeInTheDocument();
    // three's Size control is now the generic rect SizeField, homed on the
    // registry `size` key (GroupField emits data-field="size"); the old
    // `scale`-keyed field is gone.
    expect(document.querySelector('[data-field="size"]')).not.toBeNull();
    expect(screen.queryByTestId("size-field")).not.toBeNull();
    expect(document.querySelector('[data-field="scale"]')).toBeNull();
    // The scene-transform gizmo lives on the 3D tab — not on Transform.
    expect(screen.queryByTestId("three-camera-preset")).toBeNull();
    expect(screen.queryByTestId("three-reset")).toBeNull();
  });

  it("still shows the header label and + Add button", () => {
    renderPanel();
    // Header present
    expect(screen.getByTestId("layers-inspector-panel")).toBeInTheDocument();
    // + Add present in draft mode
    expect(screen.getByText("Add")).toBeInTheDocument();
  });

  it("shows the image-info section when an image overlay is selected", () => {
    renderPanel("o3");
    const info = screen.getByTestId("overlay-asset-info");
    expect(info).toBeInTheDocument();
    expect(info).toHaveTextContent("logo.png");
    expect(info).toHaveTextContent("512×512");
  });

  it("renders the audio-details body + source file when an audio clip is selected", () => {
    renderPanel("a1");
    const body = screen.getByTestId("audio-details-body");
    expect(body).toBeInTheDocument();
    // Source is the linked scene's VIDEO file; the linked scene name shows.
    expect(body).toHaveTextContent("base.mp4");
    expect(body).toHaveTextContent("Base");
    // It must NOT fall through to a scene-details panel.
    expect(screen.queryByTestId("inspector-scene-name")).toBeNull();
  });

  it("the transcribe button opens the ask-agent composer with the source file", () => {
    const onTranscribeAudio = vi.fn();
    renderPanel("a1", { onTranscribeAudio });
    fireEvent.click(screen.getByTestId("audio-transcribe"));
    expect(onTranscribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f1", fileName: "base.mp4", label: "scene audio" }),
    );
  });
});
