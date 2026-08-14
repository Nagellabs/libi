// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";

// The Style tab no longer mounts <PresetRow> (full-overlay presets moved to the
// inspector-header Preset dialog). Mock the overlay-preset hooks defensively so
// any transitive import renders with no QueryClient.
const applyMutate = vi.fn();
vi.mock("@/lib/queries/overlay-presets", () => ({
  useOverlayPresets: () => ({
    data: [
      { id: "clean", name: "Clean", kind: "text", source: "bundled", fields: { color: "#ffffff" } },
      {
        id: "boxed",
        name: "Boxed",
        kind: "text",
        source: "user",
        fields: {
          color: "#ffffff",
          background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 },
        },
      },
    ],
    isLoading: false,
  }),
  useApplyPreset: () => ({ mutate: applyMutate }),
  useSavePreset: () => ({ mutate: vi.fn() }),
  useDeletePreset: () => ({ mutate: vi.fn() }),
}));

import { CaptionInspector } from "@/components/preview/caption-inspector";
import type { TextOverlay } from "@/lib/engine/types";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";

afterEach(() => cleanup());

function makeOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "o1",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
    fontSize: 48,
    ...over,
  };
}

function renderInspector(
  over: Partial<TextOverlay> = {},
  mode: InspectorGroup = "transform",
) {
  const onPatch = vi.fn();
  render(
    <CaptionInspector overlay={makeOverlay(over)} onPatch={onPatch} mode={mode} pieceId="p1" />,
  );
  return { onPatch };
}

function dataFields(): string[] {
  return Array.from(document.querySelectorAll("[data-field]")).map(
    (el) => el.getAttribute("data-field")!,
  );
}

describe("CaptionInspector — four intent groups", () => {
  it("mounts for a text overlay", () => {
    renderInspector({}, "transform");
    expect(screen.getByTestId("caption-inspector")).toBeInTheDocument();
  });

  describe("Transform group", () => {
    it("shows placement (anchor pad), the in-plane panel, a 2D rotate + a fontSize mirror", () => {
      renderInspector({}, "transform");
      expect(screen.getByTestId("anchor-pad")).toBeInTheDocument();
      const fields = new Set(dataFields());
      expect(fields).toContain("transformPosX");
      // 2D rotate lives on the transform tab now.
      expect(fields).toContain("rotation");
      expect(fields).toContain("opacity");
      // The Size mirror carries data-field="fontSize" too.
      expect(fields).toContain("fontSize");
      // The 3D rotation/Z keys moved to the 3D tab.
      expect(fields).not.toContain("transformAngle");
      expect(fields).not.toContain("transformPosZ");
      // Style + Text group fields are NOT on the transform tab.
      expect(screen.queryByTestId("caption-content")).toBeNull();
      expect(screen.queryByTestId("background-toggle")).toBeNull();
    });

    it("clicking an anchor snaps the caption to that region of the canvas", () => {
      // The anchor pad is canvas-relative alignment: clicking "top-center" sets
      // the anchor pin AND moves the box to the top-center of the frame (default
      // 1920×1080) with a safe margin, recomputing the derived rect so the
      // preview repaints instantly. (Box is 100×50; 6% margin ⇒ y≈65.)
      const { onPatch } = renderInspector({}, "transform");
      fireEvent.click(screen.getByTestId("anchor-cell-top-center"));
      expect(onPatch).toHaveBeenCalledWith({
        anchor: "top-center",
        position: { x: 960, y: 65 },
        rect: { x: 910, y: 65, width: 100, height: 50 },
      });
    });
  });

  describe("Style group", () => {
    it("shows the static style grid, color, background, stroke, shadow + reveal pointer", () => {
      renderInspector({}, "style");
      // Single static look picker (no PresetRow chips — full-overlay presets
      // moved to the inspector-header Preset button/dialog).
      expect(screen.getByTestId("caption-style-grid")).toBeInTheDocument();
      expect(document.querySelector('[data-style="clean"]')).not.toBeNull();
      expect(document.querySelector('[data-preset]')).toBeNull();
      expect(screen.getByTestId("caption-color")).toBeInTheDocument();
      expect(screen.getByTestId("background-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("stroke-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("shadow-toggle")).toBeInTheDocument();
      // Word reveal moved to the Effects → Reveal tab; only a pointer remains.
      expect(screen.getByText(/word reveals/i)).toBeInTheDocument();
      // The old in-Style reveal mode dropdown is gone.
      expect(screen.queryByTestId("reveal-mode")).toBeNull();
      // Transform + Text group fields are NOT on the style tab.
      expect(screen.queryByTestId("caption-content")).toBeNull();
      expect(screen.queryByTestId("anchor-pad")).toBeNull();
      // 3D moved to its own tab — not on Style anymore.
      expect(screen.queryByTestId("text3d-toggle")).toBeNull();
    });

    it("toggling Background ON sends a background object", () => {
      const { onPatch } = renderInspector({}, "style");
      fireEvent.click(screen.getByTestId("background-toggle"));
      const arg = onPatch.mock.calls[0][0];
      expect(arg.background).toMatchObject({ color: expect.any(String) });
    });

    it("toggling Background OFF clears background", () => {
      const { onPatch } = renderInspector(
        { background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 } },
        "style",
      );
      fireEvent.click(screen.getByTestId("background-toggle"));
      expect(onPatch).toHaveBeenCalledWith({ background: null });
    });

    it("background detail fields stay mounted (dimmed) when off", () => {
      renderInspector({}, "style");
      expect(screen.getByTestId("background-color")).toBeInTheDocument();
      expect(screen.getByTestId("background-color")).toBeDisabled();
    });

  });

  describe("Text group", () => {
    it("shows content + typography, but NOT a Size control (Size lives on Transform)", () => {
      renderInspector({}, "text");
      expect(screen.getByTestId("caption-content")).toBeInTheDocument();
      expect(screen.getByTestId("caption-font-family")).toBeInTheDocument();
      expect(screen.getByTestId("caption-align-center")).toBeInTheDocument();
      // Size (fontSize) was removed from the Text tab — it's on Transform only.
      expect(new Set(dataFields())).not.toContain("fontSize");
      // Transform + Style group fields are NOT on the text tab.
      expect(screen.queryByTestId("background-toggle")).toBeNull();
      expect(screen.queryByTestId("anchor-pad")).toBeNull();
    });

    it("keeps the wrap-width slider mounted but disabled when wrap is off", () => {
      renderInspector({}, "text");
      // The Max-width slider is always present (not unmounted); disabled until
      // the Wrap toggle is on. Scope to that row via its "Max width" label.
      const row = screen.getByText("Max width").parentElement!;
      const num = row.querySelector(
        '[data-testid="number-slider-number"]',
      ) as HTMLInputElement;
      expect(num).toBeDisabled();
    });

    it("commits content edits on change", () => {
      const { onPatch } = renderInspector({}, "text");
      fireEvent.change(screen.getByTestId("caption-content"), {
        target: { value: "World" },
      });
      expect(onPatch).toHaveBeenCalledWith({ content: "World" });
    });

    it("clicking align center calls onPatch with align center", () => {
      const { onPatch } = renderInspector({}, "text");
      fireEvent.click(screen.getByTestId("caption-align-center"));
      expect(onPatch).toHaveBeenCalledWith({ align: "center" });
    });

    it("wrap toggle ON sets maxWidthPct; OFF unsets it", () => {
      const { onPatch } = renderInspector({}, "text");
      fireEvent.click(screen.getByTestId("caption-wrap-toggle"));
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ maxWidthPct: expect.any(Number) }),
      );
      onPatch.mockClear();
      cleanup();
      const second = renderInspector({ maxWidthPct: 0.8 }, "text");
      fireEvent.click(screen.getByTestId("caption-wrap-toggle"));
      expect(second.onPatch).toHaveBeenCalledWith({ maxWidthPct: undefined });
    });
  });

  describe("3D group", () => {
    it("shows the Make-it-3D gate; spatial angles render only past the gate", () => {
      // FLAT (no place3d / threeD) → only the gate toggle; no spatial angles.
      renderInspector({}, "3d");
      expect(screen.getByTestId("place3d-toggle")).toBeInTheDocument();
      const flatFields = new Set(dataFields());
      expect(flatFields).toContain("place3d");
      expect(flatFields).not.toContain("transformAngle");
      // Spin is NOT on the 3D tab anymore (moved to Transform).
      expect(flatFields).not.toContain("transformSpin");
      cleanup();

      // IN 3D (legacy threeD infers 3D) → the Pose grid + rotation dial render on
      // the surface inside the manual-angles container.
      renderInspector({ threeD: { depth: 20 } }, "3d");
      const container = screen.getByTestId("manual-angles");
      expect(container.tagName.toLowerCase()).not.toBe("details");
      const fields = new Set(dataFields());
      expect(fields).toContain("transform3d.pose");
      expect(fields).toContain("transform3d.rotation");
      expect(fields).toContain("transformPosZ");
      // The per-axis Angle/Elevation sliders + the in-plane Spin slider are gone
      // from the 3D tab (rotation now lives in the dial).
      expect(fields).not.toContain("transformAngle");
      expect(fields).not.toContain("transformElevation");
      expect(fields).not.toContain("transformSpin");
      // Transform / Style / Text fields are NOT on the 3D tab.
      expect(screen.queryByTestId("caption-content")).toBeNull();
      expect(screen.queryByTestId("background-toggle")).toBeNull();
      expect(screen.queryByTestId("anchor-pad")).toBeNull();
    });

    it("extrusion geometry fields stay mounted (disabled) when Extrude is off", () => {
      // place3d on but no threeD → in 3D mode, Extrude toggle present, AND the
      // extrusion controls render disabled-not-hidden (no Advanced disclosure).
      renderInspector({ place3d: true }, "3d");
      expect(screen.getByTestId("text3d-toggle")).toBeInTheDocument();
      const offFields = new Set(dataFields());
      expect(offFields).toContain("text3dDepth");
      // The duplicate extrusion "Camera" preset grid was removed — orientation is
      // driven by the unified Pose grid + dial above.
      expect(screen.queryByTestId("text3d-camera-grid")).toBeNull();
      // Thickness slider is disabled while Extrude is off.
      const thickness = document
        .querySelector('[data-field="text3dDepth"]')!
        .querySelector('[data-testid="number-slider-number"]') as HTMLInputElement;
      expect(thickness).toBeDisabled();
      cleanup();
      // With extrusion ON, the same fields render enabled.
      renderInspector({ threeD: { depth: 20 } }, "3d");
      expect(new Set(dataFields())).toContain("text3dDepth");
      const onThickness = document
        .querySelector('[data-field="text3dDepth"]')!
        .querySelector('[data-testid="number-slider-number"]') as HTMLInputElement;
      expect(onThickness).not.toBeDisabled();
    });

    it("the Thickness slider is labelled 'Thickness' (not Depth)", () => {
      renderInspector({ threeD: { depth: 20 } }, "3d");
      const wrapper = document.querySelector('[data-field="text3dDepth"]')!;
      expect(wrapper.textContent).toContain("Thickness");
    });

    it("the Pose grid edits transform3d.rotation (preserved on a place3d caption)", () => {
      const { onPatch } = renderInspector({ place3d: true }, "3d");
      // The unified Pose grid writes transform3d (rotation pose), NOT threeD.tilt.
      const poseGrid = screen.getByTestId("text-pose-grid");
      fireEvent.click(within(poseGrid).getByTestId("camera-preset-ground"));
      const arg = onPatch.mock.calls.at(-1)![0];
      expect(arg.transform3d).toBeDefined();
      expect(arg.transform3d.rotation.x).toBeGreaterThan(0);
      expect(arg.threeD).toBeUndefined();
    });

    it("renders a Reset 3D button on the text 3D tab", () => {
      renderInspector({ threeD: { depth: 20 } }, "3d");
      expect(screen.getByTestId("text-reset-3d")).toHaveTextContent("Reset 3D");
    });

    it("turning the Make-it-3D gate OFF clears place3d + threeD (flattens safely)", () => {
      const { onPatch } = renderInspector({ threeD: { depth: 20 } }, "3d");
      fireEvent.click(screen.getByTestId("place3d-toggle"));
      const arg = onPatch.mock.calls[0][0];
      expect(arg.place3d).toBe(false);
      expect(arg.threeD).toBeNull();
    });

    it("turning the Make-it-3D gate ON sets place3d (no auto-extrusion)", () => {
      const { onPatch } = renderInspector({}, "3d");
      fireEvent.click(screen.getByTestId("place3d-toggle"));
      const arg = onPatch.mock.calls[0][0];
      expect(arg.place3d).toBe(true);
      // Depth default 0 — toggling the gate ON does NOT create threeD.
      expect(arg.threeD).toBeUndefined();
    });

    it("the Extrude toggle clears threeD when turned off", () => {
      const { onPatch } = renderInspector({ threeD: { depth: 20 } }, "3d");
      fireEvent.click(screen.getByTestId("text3d-toggle"));
      const arg = onPatch.mock.calls[0][0];
      expect(arg.threeD).toBeNull();
    });

    it("the rotation dial patches transform3d (in 3D mode)", () => {
      const { onPatch } = renderInspector({ threeD: { depth: 20 } }, "3d");
      // The dial's Angle (rotation.y) degree input lives under the
      // transform3d.rotation field.
      const input = document.querySelector(
        '[data-field="transform3d.rotation"] [data-testid="rotation-input-y"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "45" } });
      const arg = onPatch.mock.calls.at(-1)![0];
      expect(arg.transform3d).toBeDefined();
      expect(arg.transform3d.rotation.y).toBeCloseTo(Math.PI / 4, 4);
    });
  });

  describe("Size control (fontSize lives on the Transform tab only)", () => {
    it("editing the transform-tab Size patches fontSize", () => {
      const { onPatch } = renderInspector({ fontSize: 40 }, "transform");
      // The transform Size control is a NumberSlider; drive its number input.
      const mirror = document.querySelector('[data-field="fontSize"]')!;
      const input = mirror.querySelector('input[type="number"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "72" } });
      expect(onPatch).toHaveBeenCalledWith({ fontSize: 72 });
    });

    it("the Text tab has no Size control", () => {
      renderInspector({ fontSize: 40 }, "text");
      expect(document.querySelector('[data-field="fontSize"]')).toBeNull();
    });
  });
});

describe("CaptionInspector — onFlush (instant-paint persistence seam)", () => {
  function renderWithFlush(
    over: Partial<TextOverlay> = {},
    mode: InspectorGroup = "style",
  ) {
    const onPatch = vi.fn();
    const onFlush = vi.fn();
    render(
      <CaptionInspector
        overlay={makeOverlay(over)}
        onPatch={onPatch}
        onFlush={onFlush}
        mode={mode}
        pieceId="p1"
      />,
    );
    return { onPatch, onFlush };
  }

  it("a discrete edit (alignment button) commits via onPatch AND flushes", () => {
    const { onPatch, onFlush } = renderWithFlush({}, "text");
    fireEvent.click(screen.getByTestId("caption-align-center"));
    expect(onPatch).toHaveBeenCalledWith({ align: "center" });
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("a discrete color edit commits AND flushes", () => {
    const { onPatch, onFlush } = renderWithFlush({}, "style");
    fireEvent.change(screen.getByTestId("caption-color"), {
      target: { value: "#ff0000" },
    });
    expect(onPatch).toHaveBeenCalledWith({ color: "#ff0000" });
    expect(onFlush).toHaveBeenCalled();
  });

  it("a continuous slider drag paints per-change but only flushes on release", () => {
    const { onPatch, onFlush } = renderWithFlush({ fontSize: 40 }, "transform");
    const sizeField = document.querySelector('[data-field="fontSize"]')!;
    const range = sizeField.querySelector('input[type="range"]') as HTMLInputElement;
    // Drag: each change paints, none flush yet.
    fireEvent.change(range, { target: { value: "60" } });
    fireEvent.change(range, { target: { value: "80" } });
    expect(onPatch).toHaveBeenCalled();
    expect(onFlush).not.toHaveBeenCalled();
    // Release → flush once.
    fireEvent.pointerUp(range);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
