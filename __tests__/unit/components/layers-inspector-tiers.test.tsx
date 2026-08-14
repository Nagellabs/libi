// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// OverlayInspectorBody now mounts <EffectsInspector> (effects mutation hooks).
// Mock them so this render needs no QueryClient.
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

// The transform/3D field groups read `setGizmoMode` from the editor-state context
// to auto-switch the canvas gizmo. Stub the hook so they render without a provider.
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ setGizmoMode: vi.fn() }),
}));

import { OverlayInspectorBody } from "@/components/preview/layers-inspector-panel";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import type { CodeOverlay, ImageOverlay, Overlay } from "@/lib/engine/types";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";

function makeImageOverlay(over: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "o1",
    kind: "image",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    fileId: "f1",
    ...over,
  };
}

function makeCodeOverlay(over: Partial<CodeOverlay> = {}): CodeOverlay {
  return {
    id: "c1",
    kind: "code",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    drawFunction: "// draw",
    ...over,
  };
}

function renderBody(overlay: Overlay, mode: InspectorGroup) {
  render(
    <OverlayInspectorBody
      overlay={overlay}
      mode={mode}
      onCommit={vi.fn()}
      pieceId="p1"
      effectHighlightStore={createEffectHighlightStore()}
      onOpenEffects={vi.fn()}
      effectsReadOnly={false}
    />,
  );
}

function dataFields(): string[] {
  return Array.from(document.querySelectorAll("[data-field]")).map(
    (el) => el.getAttribute("data-field")!,
  );
}

afterEach(() => cleanup());

// Universal-3D model: image/code/video have TWO groups (Transform + 3D). The
// Transform tab holds the always-on PLANAR controls — opacity + the planar
// Transform panel (transformPosX/Y/Spin/Size) plus zOrder/timing (mounted
// behind the in-group "Advanced ▾" reveal). The out-of-plane SPATIAL controls
// (Angle/Elevation/Depth-Z) + the place3d gate live on the 3D tab.
describe("OverlayInspectorBody transform group (image)", () => {
  it("renders opacity/zOrder/timing + the PLANAR Transform keys, no spatial/rect/flip", () => {
    renderBody(makeImageOverlay(), "transform");
    const fields = dataFields();
    expect(new Set(fields)).toEqual(
      new Set([
        "opacity",
        "zOrder",
        "startTime",
        "endTime",
        "transformPosX",
        "transformPosY",
        "transformSpin",
        "transformSize",
      ]),
    );
    // Spatial keys + the gate are on the 3D tab, NOT here.
    expect(fields).not.toContain("transformAngle");
    expect(fields).not.toContain("transformElevation");
    expect(fields).not.toContain("transformPosZ");
    expect(fields).not.toContain("place3d");
    // The old rect/rotation/flip + lane-group controls are gone entirely.
    expect(fields).not.toContain("position");
    expect(fields).not.toContain("rotation");
    expect(fields).not.toContain("flipH");
    expect(fields).not.toContain("group");
  });

  it("renders the place3d gate + the spatial keys on the 3D tab (no Scale)", () => {
    renderBody(makeImageOverlay(), "3d");
    expect(new Set(dataFields())).toEqual(
      new Set(["place3d", "transform3d.pose", "transform3d.rotation", "transformPosZ"]),
    );
  });
});

describe("OverlayInspectorBody transform group (code)", () => {
  it("renders opacity + the PLANAR Transform panel + zOrder/timing on the transform tab", () => {
    renderBody(makeCodeOverlay(), "transform");
    const fields = dataFields();
    expect(new Set(fields)).toEqual(
      new Set([
        "opacity",
        "zOrder",
        "startTime",
        "endTime",
        "transformPosX",
        "transformPosY",
        "transformSpin",
        "transformSize",
      ]),
    );
    expect(fields).not.toContain("group");
  });

  it("renders the place3d gate + the spatial keys on the 3D tab (code, no Scale)", () => {
    renderBody(makeCodeOverlay(), "3d");
    expect(new Set(dataFields())).toEqual(
      new Set(["place3d", "transform3d.pose", "transform3d.rotation", "transformPosZ"]),
    );
  });
});

// Visible/Locked + Ask-agent are meta controls (not registry fields): shown
// once, on the transform tab only. The Effects sub-panel (<EffectsInspector>,
// testId "inspector-effects") is an always-on sub-panel for non-tracked
// overlays, like the caption/three inspectors.
describe("OverlayInspectorBody meta controls are transform-tab only", () => {
  it("renders Visible/Locked + Ask-agent on the transform tab; Effects sub-panel present", () => {
    renderBody(makeCodeOverlay(), "transform");
    expect(screen.getByTestId("inspector-hide")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-lock")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-effects")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-ask-agent")).toBeInTheDocument();
  });
});
