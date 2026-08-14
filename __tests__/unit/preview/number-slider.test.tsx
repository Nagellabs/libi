// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  NumberSlider,
  snapToDetents,
} from "@/components/preview/number-slider";

describe("snapToDetents", () => {
  it("snaps to the nearest detent", () => {
    expect(snapToDetents(43, [0, 15, 30, 45, 90])).toBe(45);
    expect(snapToDetents(7, [0, 15, 30, 45, 90])).toBe(0);
    expect(snapToDetents(80, [0, 15, 30, 45, 90])).toBe(90);
  });

  it("returns the value unchanged when no detents", () => {
    expect(snapToDetents(43, [])).toBe(43);
  });
});

describe("NumberSlider", () => {
  it("renders an input reflecting the value", () => {
    render(
      <NumberSlider value={64} min={0} max={200} onChange={() => {}} />,
    );
    const numberInput = screen.getByTestId("number-slider-number") as HTMLInputElement;
    expect(numberInput.value).toBe("64");
  });

  it("fires onChange when the number input changes", () => {
    const onChange = vi.fn();
    render(
      <NumberSlider value={64} min={0} max={200} onChange={onChange} />,
    );
    const numberInput = screen.getByTestId("number-slider-number");
    fireEvent.change(numberInput, { target: { value: "80" } });
    expect(onChange).toHaveBeenCalledWith(80);
  });

  it("snaps the range value to the nearest detent (no Alt)", () => {
    const onChange = vi.fn();
    render(
      <NumberSlider
        value={0}
        min={0}
        max={90}
        detents={[0, 15, 30, 45, 90]}
        onChange={onChange}
      />,
    );
    const range = screen.getByTestId("number-slider-range");
    fireEvent.change(range, { target: { value: "43" } });
    expect(onChange).toHaveBeenCalledWith(45);
  });
});
