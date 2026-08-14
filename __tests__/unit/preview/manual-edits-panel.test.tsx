// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ManualEditsPanel } from "@/components/preview/manual-edits-panel";

describe("ManualEditsPanel (staged edit form)", () => {
  it("staging a delete shows the dirty footer; Save commits the staged ids", async () => {
    const onJump = vi.fn();
    const onApplyDeletes = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEditsPanel
        anchors={[
          { id: "man-3000", time: 3, bbox: [0, 0, 1, 1] },
          { id: "man-8000", time: 8, bbox: [0, 0, 1, 1] },
        ]}
        onJump={onJump}
        onApplyDeletes={onApplyDeletes}
        onRetrack={vi.fn()}
      />,
    );

    expect(screen.getByText(/00:03/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("manual-edit-jump-man-3000"));
    expect(onJump).toHaveBeenCalledWith(3);

    // No footer until something is staged.
    expect(screen.queryByTestId("manual-edit-dirty-footer")).not.toBeInTheDocument();

    // Stage one delete → footer appears, row is struck through, Undo restores.
    fireEvent.click(screen.getByTestId("manual-edit-delete-man-3000"));
    expect(screen.getByTestId("manual-edit-dirty-footer")).toBeInTheDocument();
    expect(screen.getByTestId("manual-edit-undo-man-3000")).toBeInTheDocument();

    // Save commits only the staged id, not the untouched one.
    fireEvent.click(screen.getByTestId("manual-edit-save"));
    await waitFor(() =>
      expect(onApplyDeletes).toHaveBeenCalledWith(["man-3000"]),
    );
  });

  it("Cancel discards staged removals without calling the server", () => {
    const onApplyDeletes = vi.fn();
    render(
      <ManualEditsPanel
        anchors={[{ id: "man-3000", time: 3, bbox: [0, 0, 1, 1] }]}
        onJump={vi.fn()}
        onApplyDeletes={onApplyDeletes}
        onRetrack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("manual-edit-delete-man-3000"));
    expect(screen.getByTestId("manual-edit-dirty-footer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("manual-edit-cancel"));
    expect(screen.queryByTestId("manual-edit-dirty-footer")).not.toBeInTheDocument();
    expect(onApplyDeletes).not.toHaveBeenCalled();
  });

  it("Clear all stages every anchor (one Save reverts them all)", async () => {
    const onApplyDeletes = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEditsPanel
        anchors={[
          { id: "man-3000", time: 3, bbox: [0, 0, 1, 1] },
          { id: "man-8000", time: 8, bbox: [0, 0, 1, 1] },
        ]}
        onJump={vi.fn()}
        onApplyDeletes={onApplyDeletes}
        onRetrack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("manual-edit-clear-all"));
    fireEvent.click(screen.getByTestId("manual-edit-save"));
    await waitFor(() =>
      expect(onApplyDeletes).toHaveBeenCalledWith(["man-3000", "man-8000"]),
    );
  });

  it("fires onRetrack and renders empty-state with disabled clear-all when no anchors", () => {
    const onRetrack = vi.fn();
    render(
      <ManualEditsPanel
        anchors={[]}
        onJump={vi.fn()}
        onApplyDeletes={vi.fn()}
        onRetrack={onRetrack}
      />,
    );
    expect(screen.getByText(/Drag a tracked overlay/i)).toBeInTheDocument();
    expect(screen.getByTestId("manual-edit-clear-all")).toBeDisabled();
    fireEvent.click(screen.getByTestId("manual-edit-retrack"));
    expect(onRetrack).toHaveBeenCalled();
  });
});
