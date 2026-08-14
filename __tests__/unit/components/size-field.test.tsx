// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SizeField } from "@/components/preview/size-field";

const baseBoxProps = {
  sizeMode: "box" as const,
  width: 200,
  height: 100,
  onToggleSplit: vi.fn(),
  onCommitWidth: vi.fn(),
  onCommitHeight: vi.fn(),
};

describe("SizeField — text mode", () => {
  it("renders a single 'Size' row and NO split toggle", () => {
    render(
      <SizeField
        sizeMode="text"
        split={false}
        width={0}
        height={0}
        fontSize={48}
        onToggleSplit={vi.fn()}
        onCommitWidth={vi.fn()}
        onCommitHeight={vi.fn()}
        onCommitFontSize={vi.fn()}
      />,
    );
    expect(screen.getByTestId("size-field")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    // No split/consolidate affordance for text.
    expect(screen.queryByTestId("size-split-toggle")).toBeNull();
    expect(screen.queryByTestId("size-consolidate-toggle-w")).toBeNull();
    expect(screen.queryByTestId("size-consolidate-toggle-h")).toBeNull();
    // One numeric row.
    expect(screen.getAllByTestId("number-slider-number")).toHaveLength(1);
  });

  it("fires onCommitFontSize when the value changes", () => {
    const onCommitFontSize = vi.fn();
    render(
      <SizeField
        sizeMode="text"
        split={false}
        width={0}
        height={0}
        fontSize={48}
        onToggleSplit={vi.fn()}
        onCommitWidth={vi.fn()}
        onCommitHeight={vi.fn()}
        onCommitFontSize={onCommitFontSize}
      />,
    );
    fireEvent.change(screen.getByTestId("number-slider-number"), {
      target: { value: "72" },
    });
    expect(onCommitFontSize).toHaveBeenCalledWith(72);
  });
});

describe("SizeField — box mode, consolidated (split=false)", () => {
  it("renders ONE 'Size' row with a split toggle", () => {
    render(<SizeField {...baseBoxProps} split={false} />);
    expect(screen.getByTestId("size-split-toggle")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getAllByTestId("number-slider-number")).toHaveLength(1);
    // No consolidate toggles while consolidated.
    expect(screen.queryByTestId("size-consolidate-toggle-w")).toBeNull();
  });

  it("clicking the 'Size' label fires onToggleSplit(true)", () => {
    const onToggleSplit = vi.fn();
    render(<SizeField {...baseBoxProps} split={false} onToggleSplit={onToggleSplit} />);
    fireEvent.click(screen.getByTestId("size-split-toggle"));
    expect(onToggleSplit).toHaveBeenCalledWith(true);
  });

  it("changing Size fires BOTH onCommitWidth and onCommitHeight with an aspect-locked height", () => {
    const onCommitWidth = vi.fn();
    const onCommitHeight = vi.fn();
    // width 200, height 100 → aspect 2. New width 400 → height 200.
    render(
      <SizeField
        {...baseBoxProps}
        split={false}
        width={200}
        height={100}
        onCommitWidth={onCommitWidth}
        onCommitHeight={onCommitHeight}
      />,
    );
    fireEvent.change(screen.getByTestId("number-slider-number"), {
      target: { value: "400" },
    });
    expect(onCommitWidth).toHaveBeenCalledWith(400);
    expect(onCommitHeight).toHaveBeenCalledWith(200);
  });
});

describe("SizeField — box mode, split (split=true)", () => {
  it("renders W and H rows each with a consolidate toggle", () => {
    render(<SizeField {...baseBoxProps} split={true} />);
    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("H")).toBeInTheDocument();
    expect(screen.getByTestId("size-consolidate-toggle-w")).toBeInTheDocument();
    expect(screen.getByTestId("size-consolidate-toggle-h")).toBeInTheDocument();
    expect(screen.getAllByTestId("number-slider-number")).toHaveLength(2);
    expect(screen.queryByTestId("size-split-toggle")).toBeNull();
  });

  it("clicking a consolidate toggle fires onToggleSplit(false)", () => {
    const onToggleSplit = vi.fn();
    render(<SizeField {...baseBoxProps} split={true} onToggleSplit={onToggleSplit} />);
    fireEvent.click(screen.getByTestId("size-consolidate-toggle-w"));
    expect(onToggleSplit).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("size-consolidate-toggle-h"));
    expect(onToggleSplit).toHaveBeenCalledWith(false);
  });

  it("W row fires only onCommitWidth; H row fires only onCommitHeight", () => {
    const onCommitWidth = vi.fn();
    const onCommitHeight = vi.fn();
    render(
      <SizeField
        {...baseBoxProps}
        split={true}
        onCommitWidth={onCommitWidth}
        onCommitHeight={onCommitHeight}
      />,
    );
    const [wInput, hInput] = screen.getAllByTestId("number-slider-number");
    fireEvent.change(wInput, { target: { value: "320" } });
    expect(onCommitWidth).toHaveBeenCalledWith(320);
    expect(onCommitHeight).not.toHaveBeenCalled();

    fireEvent.change(hInput, { target: { value: "180" } });
    expect(onCommitHeight).toHaveBeenCalledWith(180);
  });
});

describe("SizeField — disabled (3D mode → Scale is the sizer)", () => {
  it("renders disabled sliders + the hint, and does not toggle on label click", () => {
    const onToggleSplit = vi.fn();
    render(
      <SizeField
        {...baseBoxProps}
        split={false}
        disabled
        disabledHint="Use Scale on the 3D tab"
        onToggleSplit={onToggleSplit}
      />,
    );
    // The hint sublabel is shown.
    expect(screen.getByText("Use Scale on the 3D tab")).toBeInTheDocument();
    // Both the range and number inputs are disabled.
    expect(screen.getByTestId("number-slider-range")).toBeDisabled();
    expect(screen.getByTestId("number-slider-number")).toBeDisabled();
    // The split toggle is inert: clicking the label does NOT fire onToggleSplit.
    fireEvent.click(screen.getByTestId("size-split-toggle"));
    expect(onToggleSplit).not.toHaveBeenCalled();
  });

  it("disabled split mode keeps both W and H rows disabled and consolidate inert", () => {
    const onToggleSplit = vi.fn();
    render(
      <SizeField
        {...baseBoxProps}
        split={true}
        disabled
        disabledHint="Use Scale on the 3D tab"
        onToggleSplit={onToggleSplit}
      />,
    );
    const ranges = screen.getAllByTestId("number-slider-range");
    expect(ranges).toHaveLength(2);
    ranges.forEach((r) => expect(r).toBeDisabled());
    fireEvent.click(screen.getByTestId("size-consolidate-toggle-w"));
    fireEvent.click(screen.getByTestId("size-consolidate-toggle-h"));
    expect(onToggleSplit).not.toHaveBeenCalled();
  });
});

describe("SizeField — box mode, combined onCommitSize (split=false)", () => {
  it("changing Size fires onCommitSize ONCE with (width, aspectLockedHeight) and NOT onCommitWidth/onCommitHeight", () => {
    const onCommitSize = vi.fn();
    const onCommitWidth = vi.fn();
    const onCommitHeight = vi.fn();
    // width 200, height 100 → aspect 2. New width 400 → height 200.
    render(
      <SizeField
        {...baseBoxProps}
        split={false}
        width={200}
        height={100}
        onCommitSize={onCommitSize}
        onCommitWidth={onCommitWidth}
        onCommitHeight={onCommitHeight}
      />,
    );
    fireEvent.change(screen.getByTestId("number-slider-number"), {
      target: { value: "400" },
    });
    // Single combined commit carrying BOTH dimensions — the fix for the
    // top-level `rect` merge dropping the width edit.
    expect(onCommitSize).toHaveBeenCalledTimes(1);
    expect(onCommitSize).toHaveBeenCalledWith(400, 200);
    // The legacy two-call path must NOT fire when onCommitSize is provided.
    expect(onCommitWidth).not.toHaveBeenCalled();
    expect(onCommitHeight).not.toHaveBeenCalled();
  });

  it("in split mode, W/H rows still fire onCommitWidth/onCommitHeight independently (onCommitSize untouched)", () => {
    const onCommitSize = vi.fn();
    const onCommitWidth = vi.fn();
    const onCommitHeight = vi.fn();
    render(
      <SizeField
        {...baseBoxProps}
        split={true}
        onCommitSize={onCommitSize}
        onCommitWidth={onCommitWidth}
        onCommitHeight={onCommitHeight}
      />,
    );
    const [wInput, hInput] = screen.getAllByTestId("number-slider-number");
    fireEvent.change(wInput, { target: { value: "320" } });
    fireEvent.change(hInput, { target: { value: "180" } });
    expect(onCommitWidth).toHaveBeenCalledWith(320);
    expect(onCommitHeight).toHaveBeenCalledWith(180);
    // Split mode never uses the combined commit.
    expect(onCommitSize).not.toHaveBeenCalled();
  });
});
