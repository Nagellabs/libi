// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
const defaults = { value: { aspectRatioId: "9:16" } as { aspectRatioId: string } | undefined };
const updateState = { isPending: false };
vi.mock("@/lib/queries/piece-defaults", () => ({
  usePieceDefaults: () => ({ data: defaults.value, isLoading: defaults.value === undefined }),
  useUpdatePieceDefaults: () => ({ mutate, isPending: updateState.isPending }),
}));

vi.mock("@/components/settings/updates-section", () => ({ UpdatesSection: () => null }));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ previewQuality: "auto", setPreviewQuality: vi.fn() }),
}));

import { GeneralTab } from "@/components/settings/general-tab";

beforeEach(() => {
  mutate.mockClear();
  defaults.value = { aspectRatioId: "9:16" };
  updateState.isPending = false;
});

describe("GeneralTab — default aspect ratio", () => {
  it("offers every catalog ratio", () => {
    render(<GeneralTab />);
    for (const id of ["9:16", "4:5", "1:1", "16:9", "4:3", "21:9"]) {
      expect(screen.getByTestId(`default-ratio-${id}`)).toBeTruthy();
    }
  });

  it("marks the stored default as selected", () => {
    render(<GeneralTab />);
    expect(screen.getByTestId("default-ratio-9:16").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("default-ratio-16:9").getAttribute("aria-pressed")).toBe("false");
  });

  it("persists a new default on click", () => {
    render(<GeneralTab />);
    fireEvent.click(screen.getByTestId("default-ratio-16:9"));
    expect(mutate).toHaveBeenCalledWith({ aspectRatioId: "16:9" });
  });

  it("says the setting applies to NEW pieces only", () => {
    // Without this the user reasonably expects existing pieces to change.
    render(<GeneralTab />);
    expect(screen.getByTestId("default-ratio-help").textContent).toMatch(/new pieces/i);
  });

  it("renders a skeleton, not a spinner, while loading", () => {
    defaults.value = undefined;
    render(<GeneralTab />);
    expect(screen.getByTestId("default-ratio-skeleton")).toBeTruthy();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("disables the ratio buttons while the update is pending", () => {
    updateState.isPending = true;
    render(<GeneralTab />);
    expect(
      (screen.getByTestId("default-ratio-16:9") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("default-ratio-9:16") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("leaves the ratio buttons enabled when idle", () => {
    render(<GeneralTab />);
    expect(
      (screen.getByTestId("default-ratio-16:9") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
