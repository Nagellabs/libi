// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const state = {
  viewMode: "snapshot" as "snapshot" | "draft",
  setViewMode: vi.fn(),
};
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => state,
}));

import { SnapshotBanner } from "@/components/editor/snapshot-banner";

/**
 * The dismiss flag resets on the render where the user RE-ENTERS snapshot
 * view (previous-state pattern) — the banner reappears when they leave and
 * come back, but stays dismissed within one visit.
 */
describe("SnapshotBanner", () => {
  beforeEach(() => {
    state.viewMode = "snapshot";
  });

  it("renders in snapshot view and hides on dismiss", () => {
    const { rerender } = render(<SnapshotBanner />);
    expect(screen.getByText(/Viewing snapshot/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Dismiss"));
    rerender(<SnapshotBanner />);
    expect(screen.queryByText(/Viewing snapshot/)).not.toBeInTheDocument();
  });

  it("reappears after leaving snapshot view and coming back", () => {
    const { rerender } = render(<SnapshotBanner />);
    fireEvent.click(screen.getByTitle("Dismiss"));
    expect(screen.queryByText(/Viewing snapshot/)).not.toBeInTheDocument();

    state.viewMode = "draft";
    rerender(<SnapshotBanner />);
    expect(screen.queryByText(/Viewing snapshot/)).not.toBeInTheDocument();

    state.viewMode = "snapshot";
    rerender(<SnapshotBanner />);
    expect(screen.getByText(/Viewing snapshot/)).toBeInTheDocument();
  });
});
