// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  CameraPresetGrid,
  CAMERA_PRESET_LABELS,
  type CameraPreset,
} from "@/components/preview/camera-preset-grid";

const PRESETS: CameraPreset[] = [
  "billboard",
  "ground",
  "lowAngle",
  "highAngle",
  "angled",
];

describe("CameraPresetGrid", () => {
  it("renders all 5 preset tiles", () => {
    render(<CameraPresetGrid value="billboard" onChange={vi.fn()} />);
    for (const p of PRESETS) {
      expect(screen.getByTestId(`camera-preset-${p}`)).toBeInTheDocument();
    }
  });

  it("clicking each tile fires onChange with that value", () => {
    for (const p of PRESETS) {
      const onChange = vi.fn();
      const { unmount } = render(
        <CameraPresetGrid value="billboard" onChange={onChange} />,
      );
      fireEvent.click(screen.getByTestId(`camera-preset-${p}`));
      expect(onChange).toHaveBeenCalledWith(p);
      unmount();
    }
  });

  it("marks the active tile with aria-pressed true and others false", () => {
    render(<CameraPresetGrid value="lowAngle" onChange={vi.fn()} />);
    expect(screen.getByTestId("camera-preset-lowAngle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("camera-preset-billboard")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("exports a labels map covering all presets", () => {
    expect(CAMERA_PRESET_LABELS).toEqual({
      billboard: "Billboard",
      ground: "Ground",
      lowAngle: "Low angle",
      highAngle: "High angle",
      angled: "Angled",
    });
  });
});
