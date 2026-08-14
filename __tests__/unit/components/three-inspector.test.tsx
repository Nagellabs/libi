// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { ThreeInspector } from "@/components/preview/three-inspector";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import { POSE_PRESETS } from "@/lib/overlays/pose-presets";
import type { ThreeOverlay } from "@/lib/engine/types";
import type { InspectorGroup } from "@/lib/overlays/inspector-fields";

function makeOverlay(over: Partial<ThreeOverlay> = {}): ThreeOverlay {
  return {
    id: "o1",
    kind: "three",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    sceneFunction: "// scene",
    ...over,
  };
}

function renderInspector(
  over: Partial<ThreeOverlay> = {},
  mode: InspectorGroup = "3d",
) {
  const onPatch = vi.fn();
  render(<ThreeInspector overlay={makeOverlay(over)} onPatch={onPatch} mode={mode} />);
  return { onPatch };
}

function dataFields(): string[] {
  return Array.from(document.querySelectorAll("[data-field]")).map(
    (el) => el.getAttribute("data-field")!,
  );
}

/** The single number input inside the GroupField wrapping a registry key. */
function numberInputFor(fieldKey: string): HTMLInputElement {
  const wrapper = document.querySelector(`[data-field="${fieldKey}"]`) as HTMLElement;
  if (!wrapper) throw new Error(`no data-field="${fieldKey}"`);
  return within(wrapper).getAllByTestId("number-slider-number")[0] as HTMLInputElement;
}

describe("ThreeInspector", () => {
  it("renders the Pose grid + Reset + the rotation dial + Depth (no Scale)", () => {
    renderInspector({}, "3d");
    expect(screen.getByTestId("three-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("three-pose-grid")).toBeInTheDocument();
    expect(screen.getByTestId("three-reset")).toBeInTheDocument();
    // The rotation dial (2 circles: Angle + Elevation) replaces the per-axis
    // sliders. Spin (rotation.z) was removed — scene-root roll doesn't render;
    // in-plane roll lives on the 2D rotation/transformSpin control instead.
    expect(screen.getByTestId("rotation-dial-field")).toBeInTheDocument();
    expect(screen.getByTestId("gizmo-ring-angle")).toBeInTheDocument();
    expect(screen.getByTestId("gizmo-ring-elevation")).toBeInTheDocument();
    expect(screen.queryByTestId("gizmo-ring-spin")).not.toBeInTheDocument();
    expect(numberInputFor("transform3d.position")).toBeInTheDocument();
    // Scale was removed — no transform3d.scaleUniform field should render.
    expect(document.querySelector('[data-field="transform3d.scaleUniform"]')).toBeNull();
  });

  it("the Spin (rotation.z) dial ring + input are NOT rendered — in-plane roll is the 2D rotation field", () => {
    renderInspector({}, "3d");
    expect(screen.queryByTestId("gizmo-ring-spin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rotation-input-z")).not.toBeInTheDocument();
  });

  it("typing Angle (rotation.y) = 90° in the dial input emits rotation.y ≈ 1.5708", () => {
    const { onPatch } = renderInspector({}, "3d");
    const angle = screen.getByTestId("rotation-input-y") as HTMLInputElement;
    fireEvent.change(angle, { target: { value: "90" } });
    expect(onPatch).toHaveBeenCalled();
    const arg = onPatch.mock.calls[onPatch.mock.calls.length - 1][0];
    expect(arg.transform3d.rotation.y).toBeCloseTo(Math.PI / 2, 4);
    expect(arg.transform3d.rotation.x).toBe(0);
    expect(arg.transform3d.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("clicking a Pose tile snaps rotation to that pose (preserving spin)", () => {
    const { onPatch } = renderInspector({}, "3d");
    fireEvent.click(screen.getByTestId("camera-preset-ground"));
    expect(onPatch).toHaveBeenCalled();
    const arg = onPatch.mock.calls[onPatch.mock.calls.length - 1][0];
    expect(arg.transform3d.rotation.x).toBeCloseTo(POSE_PRESETS.ground.rotationX, 6);
    expect(arg.transform3d.rotation.y).toBeCloseTo(POSE_PRESETS.ground.rotationY, 6);
  });

  it("Reset transform emits identity", () => {
    const { onPatch } = renderInspector(
      {
        transform3d: {
          position: { x: 5, y: 0, z: 0 },
          rotation: { x: 1, y: 2, z: 3 },
        },
      },
      "3d",
    );
    fireEvent.click(screen.getByTestId("three-reset"));
    expect(onPatch).toHaveBeenCalledWith({ transform3d: IDENTITY_TRANSFORM3D });
  });

  it("the Scale (scaleUniform) field is NOT rendered — it was removed along with the registry entry", () => {
    renderInspector({}, "3d");
    expect(document.querySelector('[data-field="transform3d.scaleUniform"]')).toBeNull();
  });

  it("Depth (position.z) edit updates only position.z, rounded to an integer", () => {
    const { onPatch } = renderInspector({}, "3d");
    const depth = numberInputFor("transform3d.position");
    // Depth is integer-only now (a fractional 1.5 rounds to 2). World-unit depth
    // spans only ±DEPTH_LIMIT_WORLD, so integer steps give a visible — not a ~3%
    // — size change per step.
    fireEvent.change(depth, { target: { value: "1.5" } });
    expect(onPatch).toHaveBeenCalled();
    const arg = onPatch.mock.calls[onPatch.mock.calls.length - 1][0];
    expect(arg.transform3d.position).toEqual({ x: 0, y: 0, z: 2 });
    expect(arg.transform3d.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("relabels the reset button to Reset 3D", () => {
    renderInspector({}, "3d");
    expect(screen.getByTestId("three-reset")).toHaveTextContent("Reset 3D");
  });

  // Unified-3D model: three's scene transform lives in the 3D group as the Pose
  // grid + the rotation dial + Depth + reset. Scale was removed. The old per-axis
  // rotation sliders and camera-preset control were dropped.
  describe("3d scene-transform group", () => {
    it("renders exactly the unified 3d-group field keys (no Scale)", () => {
      renderInspector({}, "3d");
      const fields = dataFields();
      expect(new Set(fields)).toEqual(
        new Set([
          "transform3d.pose",
          "transform.reset",
          "transform3d.rotation",
          "transform3d.position",
        ]),
      );
    });
  });
});
