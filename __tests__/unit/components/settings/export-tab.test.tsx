// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mutateAsync = vi.fn();
const queryState: {
  data: unknown;
  isLoading: boolean;
} = { data: undefined, isLoading: true };

vi.mock("@/lib/queries/export-defaults", () => ({
  useExportDefaults: () => queryState,
  useUpdateExportDefaults: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/lib/shell/client", () => ({
  pickDirectory: vi.fn(async () => undefined),
  hasElectronBridge: () => false,
}));

import { ExportTab } from "@/components/settings/export-tab";

// The tab's rows are flat (label + Segmented div as direct siblings inside
// one space-y-2 container), unlike the export dialog's nested Field
// component — so the label's nearest div ancestor already scopes the row.
function mediaField(): HTMLElement {
  return screen.getByText("Videos & images").closest("div") as HTMLElement;
}
function graphicsField(): HTMLElement {
  return screen.getByText("Text, code & 3D").closest("div") as HTMLElement;
}

const loadedDefaults = {
  folder: "/Users/me/Movies",
  format: "mp4" as const,
  quality: "source" as const,
  graphicsQuality: "4k" as const,
  osDefaultFolder: "/Users/me/Movies",
  effectiveFolder: "/Users/me/Movies",
};

/**
 * The form mirror is seeded from fresh query data during render (previous-
 * state pattern keyed on React Query's referentially-stable `data`) — no
 * setState-in-effect. These tests pin the loading→loaded seeding.
 */
describe("ExportTab", () => {
  beforeEach(() => {
    queryState.data = undefined;
    queryState.isLoading = true;
    mutateAsync.mockClear();
  });

  it("shows skeletons while loading", () => {
    const { container } = render(<ExportTab />);
    expect(container.querySelectorAll("[data-slot='skeleton'], .animate-pulse").length).toBeGreaterThan(0);
  });

  it("seeds the form from the loaded defaults", () => {
    queryState.isLoading = false;
    queryState.data = { ...loadedDefaults, format: "mov", quality: "1080p" };
    render(<ExportTab />);
    expect(screen.getByDisplayValue("/Users/me/Movies")).toBeInTheDocument();
  });

  it("renders both resolution rows with Original + 4K selected at defaults", () => {
    queryState.isLoading = false;
    queryState.data = loadedDefaults;
    render(<ExportTab />);
    expect(within(mediaField()).getByRole("button", { name: "Original" }).className).toContain(
      "bg-primary",
    );
    expect(within(graphicsField()).getByRole("button", { name: "4K" }).className).toContain(
      "bg-primary",
    );
  });

  it("always renders the graphics row, regardless of any hasGraphics-style gate", () => {
    queryState.isLoading = false;
    queryState.data = loadedDefaults;
    render(<ExportTab />);
    expect(screen.getByText("Text, code & 3D")).toBeInTheDocument();
  });

  it("shows no graphics warning at 4K", () => {
    queryState.isLoading = false;
    queryState.data = loadedDefaults;
    render(<ExportTab />);
    expect(
      screen.queryByText(/Text, code and 3D may look less sharp/),
    ).not.toBeInTheDocument();
  });

  it("shows the graphics warning at 1080p and 1440p", () => {
    queryState.isLoading = false;
    queryState.data = loadedDefaults;
    render(<ExportTab />);

    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1080p" }));
    expect(screen.getByText(/Text, code and 3D may look less sharp/)).toBeInTheDocument();

    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1440p" }));
    expect(screen.getByText(/Text, code and 3D may look less sharp/)).toBeInTheDocument();
  });

  it("marks the form dirty when only graphicsQuality changes, and saves it", async () => {
    queryState.isLoading = false;
    queryState.data = loadedDefaults;
    render(<ExportTab />);

    const saveButton = screen.getByRole("button", { name: "Save defaults" });
    expect(saveButton).toBeDisabled();

    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1440p" }));
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ graphicsQuality: "1440p" }),
    );
  });
});
