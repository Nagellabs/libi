// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EffectsPanel } from "@/components/preview/effects-panel";
import { createSelectionStore } from "@/lib/preview/selection-store";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import { createEffectPreviewStore } from "@/lib/preview/effect-preview-store";
import { createKeyframeSelectionStore } from "@/lib/preview/keyframe-selection-store";
import type { Composition } from "@/lib/engine/types";

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ effectsLastPhase: "in", setEffectsLastPhase: vi.fn() }),
}));

const apply = vi.fn();
vi.mock("@/lib/queries/effects", () => ({
  useApplyLayerEffect: () => ({ mutate: apply, isPending: false }),
  useClearLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearReveal: () => ({ mutate: vi.fn(), isPending: false }),
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const comp = {
  overlays: [{ id: "ov1", kind: "text", startTime: 0, duration: 3, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hi" }],
} as unknown as Composition;

describe("EffectsPanel", () => {
  it("renders thumbnails for the selected text overlay and applies on click", () => {
    const sel = createSelectionStore("ov1");
    wrap(
      <EffectsPanel
        pieceId="p1"
        composition={comp}
        selectionStore={sel}
        effectHighlightStore={createEffectHighlightStore()} effectPreviewStore={createEffectPreviewStore()}
        keyframeSelectionStore={createKeyframeSelectionStore()}
        readOnly={false}
        onClose={vi.fn()} onAddKeyframeAtPlayhead={vi.fn()}
      />,
    );
    const fade = screen.getAllByTestId("effect-thumbnail").find((b) => b.getAttribute("data-effect-id") === "fade");
    expect(fade).toBeTruthy();
    fireEvent.click(fade!);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ layerId: "ov1", phase: "in", effectId: "fade" }));
  });

  it("shows a 'select a layer' note when nothing is selected", () => {
    const sel = createSelectionStore(null);
    wrap(
      <EffectsPanel pieceId="p1" composition={comp} selectionStore={sel}
        effectHighlightStore={createEffectHighlightStore()} effectPreviewStore={createEffectPreviewStore()}
        keyframeSelectionStore={createKeyframeSelectionStore()} readOnly={false} onClose={vi.fn()} onAddKeyframeAtPlayhead={vi.fn()} />,
    );
    expect(screen.getByText(/select a layer/i)).toBeInTheDocument();
  });

  it("disables tiles when read-only (snapshot)", () => {
    const sel = createSelectionStore("ov1");
    wrap(
      <EffectsPanel pieceId="p1" composition={comp} selectionStore={sel}
        effectHighlightStore={createEffectHighlightStore()} effectPreviewStore={createEffectPreviewStore()}
        keyframeSelectionStore={createKeyframeSelectionStore()} readOnly={true} onClose={vi.fn()} onAddKeyframeAtPlayhead={vi.fn()} />,
    );
    const fade = screen.getAllByTestId("effect-thumbnail").find((b) => b.getAttribute("data-effect-id") === "fade");
    expect(fade).toBeDisabled();
  });
});
