// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

import { AnchorPad } from "@/components/preview/anchor-pad";
import type { CaptionAnchor } from "@/lib/captions/types";

afterEach(() => cleanup());

const ALL_ANCHORS: CaptionAnchor[] = [
  "top-left", "top-center", "top-right",
  "mid-left", "mid-center", "mid-right",
  "bottom-left", "bottom-center", "bottom-right",
];

describe("AnchorPad", () => {
  it("renders the 3×3 grid container with 9 cells", () => {
    render(<AnchorPad anchor="bottom-center" onAnchorChange={vi.fn()} />);
    expect(screen.getByTestId("anchor-pad")).toBeInTheDocument();
    for (const a of ALL_ANCHORS) {
      expect(screen.getByTestId(`anchor-cell-${a}`)).toBeInTheDocument();
    }
  });

  it("clicking a cell fires onAnchorChange with that exact anchor value", () => {
    const onAnchorChange = vi.fn();
    render(<AnchorPad anchor="bottom-center" onAnchorChange={onAnchorChange} />);
    fireEvent.click(screen.getByTestId("anchor-cell-top-center"));
    expect(onAnchorChange).toHaveBeenCalledTimes(1);
    expect(onAnchorChange).toHaveBeenCalledWith("top-center");
  });

  it("fires the correct value for every cell", () => {
    for (const a of ALL_ANCHORS) {
      const onAnchorChange = vi.fn();
      render(<AnchorPad anchor="mid-center" onAnchorChange={onAnchorChange} />);
      fireEvent.click(screen.getByTestId(`anchor-cell-${a}`));
      expect(onAnchorChange).toHaveBeenCalledWith(a);
      cleanup();
    }
  });

  it("marks the active anchor cell with aria-pressed", () => {
    render(<AnchorPad anchor="top-left" onAnchorChange={vi.fn()} />);
    const active = screen.getByTestId("anchor-cell-top-left");
    expect(active).toHaveAttribute("aria-pressed", "true");
    // A non-active cell is not pressed.
    expect(screen.getByTestId("anchor-cell-bottom-right")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clickable cells are cursor-pointer", () => {
    render(<AnchorPad anchor="mid-center" onAnchorChange={vi.fn()} />);
    expect(screen.getByTestId("anchor-cell-mid-center").className).toContain(
      "cursor-pointer",
    );
  });

  it("applies a passed className to the container", () => {
    render(
      <AnchorPad anchor="mid-center" onAnchorChange={vi.fn()} className="mx-auto" />,
    );
    expect(screen.getByTestId("anchor-pad").className).toContain("mx-auto");
  });
});
