// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AspectRatioDialog } from "@/components/preview/aspect-ratio-dialog";

const onConfirm = vi.fn();
const setOpen = vi.fn();

const base = {
  open: true,
  setOpen,
  currentWidth: 1920,
  currentHeight: 1080,
  overlayCount: 0,
  onConfirm,
};

beforeEach(() => {
  onConfirm.mockClear();
  setOpen.mockClear();
});

describe("AspectRatioDialog", () => {
  it("offers every catalog ratio", () => {
    render(<AspectRatioDialog {...base} />);
    for (const id of ["9:16", "4:5", "1:1", "16:9", "4:3", "21:9"]) {
      expect(screen.getByTestId(`ratio-card-${id}`)).toBeTruthy();
    }
  });

  it("groups them by orientation", () => {
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByText("Portrait")).toBeTruthy();
    expect(screen.getByText("Square")).toBeTruthy();
    expect(screen.getByText("Landscape")).toBeTruthy();
  });

  it("preselects the piece's current ratio", () => {
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-card-16:9").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-card-9:16").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the pixel dimensions of the selected ratio", () => {
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-dimensions").textContent).toContain("1920 x 1080");
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    expect(screen.getByTestId("ratio-dimensions").textContent).toContain("1080 x 1920");
  });

  it("confirms with the selected option", () => {
    render(<AspectRatioDialog {...base} />);
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    fireEvent.click(screen.getByTestId("ratio-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: "9:16" }));
  });

  it("cannot confirm the ratio the piece already has", () => {
    // Dispatching a no-op change to the agent would be pure noise.
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(true);
  });

  it("reads 'Change ratio' for an empty piece", () => {
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-confirm").textContent).toContain("Change ratio");
  });

  it("reads 'Ask the agent' and warns about reflow when the piece has content", () => {
    render(<AspectRatioDialog {...base} overlayCount={4} />);
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    expect(screen.getByTestId("ratio-confirm").textContent).toMatch(/agent/i);
    // Set the expectation BEFORE the click, not after.
    expect(screen.getByTestId("ratio-reflow-note").textContent).toContain("4 overlays");
  });

  it("uses singular wording for one overlay", () => {
    render(<AspectRatioDialog {...base} overlayCount={1} />);
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    expect(screen.getByTestId("ratio-reflow-note").textContent).toContain("1 overlay");
    expect(screen.getByTestId("ratio-reflow-note").textContent).not.toContain("1 overlays");
  });

  it("hides the reflow note until a different ratio is picked", () => {
    render(<AspectRatioDialog {...base} overlayCount={4} />);
    expect(screen.queryByTestId("ratio-reflow-note")).toBeNull();
  });

  it("marks every card as pointer-affordant", () => {
    // base-ui does not set this; the repo requires it on every interactive element.
    render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-card-9:16").className).toContain("cursor-pointer");
  });

  it("disables confirm while a write is in flight", () => {
    // `busy` is passed by the control while the PATCH is running. Without it a
    // second click fires a second write against a piece that is mid-resize.
    const { rerender } = render(<AspectRatioDialog {...base} />);
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(false);

    rerender(<AspectRatioDialog {...base} busy />);
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(true);
  });

  it("preselects nothing when the piece is at a custom ratio", () => {
    render(<AspectRatioDialog {...base} currentWidth={1000} currentHeight={1400} />);
    for (const id of ["9:16", "4:5", "1:1", "16:9", "4:3", "21:9"]) {
      expect(screen.getByTestId(`ratio-card-${id}`).getAttribute("aria-pressed")).toBe("false");
    }
    // …and confirm is available, because any pick is a real change.
    fireEvent.click(screen.getByTestId("ratio-card-9:16"));
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(false);
  });

  it("tracks a live agent resize when the dialog is untouched", () => {
    // Untouched: no card has been clicked. An agent can resize the piece
    // while the dialog is open — the highlighted card must follow, and
    // confirm must stay disabled since there is still no real user pick.
    const { rerender } = render(<AspectRatioDialog {...base} />);
    expect(screen.getByTestId("ratio-card-16:9").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(true);

    rerender(<AspectRatioDialog {...base} currentWidth={1080} currentHeight={1920} />);

    expect(screen.getByTestId("ratio-card-9:16").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-card-16:9").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(true);
  });

  it("keeps the user's deliberate pick when an agent resize follows", () => {
    // Touched: the user clicked a card. A later agent resize must not yank
    // their pick away, and confirm must stay enabled.
    const { rerender } = render(<AspectRatioDialog {...base} />);
    fireEvent.click(screen.getByTestId("ratio-card-4:5"));
    expect(screen.getByTestId("ratio-card-4:5").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(false);

    rerender(<AspectRatioDialog {...base} currentWidth={1080} currentHeight={1920} />);

    expect(screen.getByTestId("ratio-card-4:5").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-card-9:16").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(false);
  });

  it("starts from the new current ratio on close and reopen after a resize", () => {
    const { rerender } = render(<AspectRatioDialog {...base} />);
    fireEvent.click(screen.getByTestId("ratio-card-4:5"));

    // Close, resize underneath, then reopen.
    rerender(<AspectRatioDialog {...base} open={false} />);
    rerender(<AspectRatioDialog {...base} open={false} currentWidth={1080} currentHeight={1920} />);
    rerender(<AspectRatioDialog {...base} open currentWidth={1080} currentHeight={1920} />);

    expect(screen.getByTestId("ratio-card-9:16").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ratio-card-4:5").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ratio-confirm").hasAttribute("disabled")).toBe(true);
  });
});
