// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NumberInspectorField } from "@/components/preview/number-inspector-field";

/**
 * The local draft mirrors external `value` changes on the render where they
 * arrive (previous-state pattern) — but never clobbers what the user is
 * typing when the value prop is unchanged.
 */
describe("NumberInspectorField", () => {
  it("commits a valid number on blur", () => {
    const onCommit = vi.fn();
    render(<NumberInspectorField label="X" value={10} onCommit={onCommit} />);
    const input = screen.getByTestId("inspector-X");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it("reverts to the prop value on blur when the draft is not a number", () => {
    const onCommit = vi.fn();
    render(<NumberInspectorField label="X" value={10} onCommit={onCommit} />);
    const input = screen.getByTestId("inspector-X");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("10");
  });

  it("mirrors an EXTERNAL value change into the draft", () => {
    const { rerender } = render(
      <NumberInspectorField label="X" value={10} onCommit={() => {}} />,
    );
    rerender(<NumberInspectorField label="X" value={77} onCommit={() => {}} />);
    expect(screen.getByTestId("inspector-X")).toHaveValue("77");
  });

  it("keeps the user's typing across re-renders with the SAME value", () => {
    const { rerender } = render(
      <NumberInspectorField label="X" value={10} onCommit={() => {}} />,
    );
    const input = screen.getByTestId("inspector-X");
    fireEvent.change(input, { target: { value: "5" } });
    rerender(<NumberInspectorField label="X" value={10} onCommit={() => {}} />);
    expect(input).toHaveValue("5");
  });
});
