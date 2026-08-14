// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

/**
 * The form mirror is seeded from fresh query data during render (previous-
 * state pattern keyed on React Query's referentially-stable `data`) — no
 * setState-in-effect. These tests pin the loading→loaded seeding.
 */
describe("ExportTab", () => {
  beforeEach(() => {
    queryState.data = undefined;
    queryState.isLoading = true;
  });

  it("shows skeletons while loading", () => {
    const { container } = render(<ExportTab />);
    expect(container.querySelectorAll("[data-slot='skeleton'], .animate-pulse").length).toBeGreaterThan(0);
  });

  it("seeds the form from the loaded defaults", () => {
    queryState.isLoading = false;
    queryState.data = {
      folder: "/Users/me/Movies",
      format: "mov",
      quality: "1080p",
      osDefaultFolder: "/Users/me/Movies",
      effectiveFolder: "/Users/me/Movies",
    };
    render(<ExportTab />);
    expect(screen.getByDisplayValue("/Users/me/Movies")).toBeInTheDocument();
  });
});
