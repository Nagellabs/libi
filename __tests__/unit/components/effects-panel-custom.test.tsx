// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EffectsPanel } from "@/components/preview/effects-panel";
import { createSelectionStore } from "@/lib/preview/selection-store";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import { createEffectPreviewStore } from "@/lib/preview/effect-preview-store";
import { createKeyframeSelectionStore } from "@/lib/preview/keyframe-selection-store";
import { registerCustomEffects, clearCustomEffects } from "@/lib/effects/registry";
import { compileCustomEffect } from "@/lib/effects/compile-custom";
import type { Composition } from "@/lib/engine/types";

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ effectsLastPhase: "in", setEffectsLastPhase: vi.fn() }),
}));

vi.mock("@/lib/queries/effects", () => ({
  useApplyLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearLayerEffect: () => ({ mutate: vi.fn(), isPending: false }),
  useClearReveal: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The panel reads the API payload to derive the custom-id set. Return one
// custom effect that supports text + phase "in".
vi.mock("@/lib/queries/effects-catalog", () => ({
  useCustomEffects: () => ({
    data: {
      custom: [
        {
          meta: {
            id: "my-custom-fx",
            name: "My Custom FX",
            family: "animation",
            phases: ["in"],
            supports: ["text"],
            params: [],
          },
          source: "return { opacity: progress };",
        },
      ],
    },
  }),
}));

const CUSTOM_MANIFEST = {
  id: "my-custom-fx",
  name: "My Custom FX",
  family: "animation" as const,
  phases: ["in" as const],
  supports: ["text" as const],
  params: [],
};

function registerFakeCustom() {
  const r = compileCustomEffect(CUSTOM_MANIFEST, "return { opacity: progress };");
  if (!r.ok) throw new Error("fixture failed to compile: " + r.error);
  registerCustomEffects([r.def]);
}

afterEach(() => clearCustomEffects());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const comp = {
  scenes: [],
  overlays: [
    { id: "ov1", kind: "text", startTime: 0, duration: 3, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hi" },
  ],
} as unknown as Composition;

function renderPanel() {
  const sel = createSelectionStore("ov1");
  return wrap(
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
}

describe("EffectsPanel — Custom family tab", () => {
  it("enables the Custom tab and filters to custom effects when ≥1 custom effect exists for the kind", () => {
    registerFakeCustom();
    renderPanel();

    const customTab = screen.getByTestId("effects-family-custom");
    expect(customTab).toBeInTheDocument();
    expect(customTab.tagName).toBe("BUTTON");

    // On Animations tab the custom badge IS shown on its tile (it's in the list),
    // but built-in tiles like "fade" are present too.
    expect(
      screen.getAllByTestId("effect-thumbnail").some((b) => b.getAttribute("data-effect-id") === "fade"),
    ).toBe(true);

    // Switch to Custom — only custom effects remain, badged.
    fireEvent.click(customTab);
    const tiles = screen.getAllByTestId("effect-thumbnail");
    expect(tiles.every((b) => b.getAttribute("data-effect-id") === "my-custom-fx")).toBe(true);
    expect(screen.getAllByTestId("effect-custom-badge").length).toBeGreaterThan(0);
  });

  it("renders a custom badge on the custom tile in the Animations tab", () => {
    registerFakeCustom();
    renderPanel();
    const custom = screen
      .getAllByTestId("effect-thumbnail")
      .find((b) => b.getAttribute("data-effect-id") === "my-custom-fx");
    expect(custom).toBeTruthy();
    // The badge lives inside the custom tile.
    expect(custom!.querySelector('[data-testid="effect-custom-badge"]')).toBeTruthy();
  });
});
