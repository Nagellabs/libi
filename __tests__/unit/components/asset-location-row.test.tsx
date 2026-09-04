// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const locationResult = {
  value: { data: undefined as unknown, isLoading: false } as {
    data: { path: string; exists: boolean } | null | undefined;
    isLoading: boolean;
  },
};
vi.mock("@/lib/queries/files", () => ({
  useFileLocation: () => locationResult.value,
}));

const revealFile = vi.fn(async () => {});
vi.mock("@/lib/shell/client", () => ({
  revealFile: (p: string) => revealFile(p),
  revealFileById: vi.fn(async () => {}),
  revealLabel: () => "Reveal in Finder",
  getShellPlatform: () => "darwin",
}));

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (n: string, p?: Record<string, unknown>) => trackEvent(n, p),
}));

import { AssetLocationRow } from "@/components/editor/asset-location-row";

const writeText = vi.fn(async () => {});

beforeEach(() => {
  revealFile.mockClear();
  trackEvent.mockClear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => vi.clearAllTimers());

describe("AssetLocationRow", () => {
  it("renders a skeleton while the location is loading", () => {
    locationResult.value = { data: undefined, isLoading: true };
    const { container } = render(<AssetLocationRow fileId="f1" />);
    expect(container.querySelector('[data-testid="asset-location-skeleton"]')).not.toBeNull();
    expect(screen.queryByText("Location")).toBeNull();
  });

  it("renders nothing when the file row is gone", () => {
    locationResult.value = { data: null, isLoading: false };
    const { container } = render(<AssetLocationRow fileId="f1" />);
    expect(container.textContent).toBe("");
  });

  it("shows the absolute path and reveals it on click", async () => {
    locationResult.value = {
      data: { path: "/Users/x/.libi/storage/p1/clip.mp4", exists: true },
      isLoading: false,
    };
    render(<AssetLocationRow fileId="f1" />);

    expect(screen.getByText("Location")).toBeTruthy();
    expect(screen.getByTestId("asset-location-path").textContent).toBe(
      "/Users/x/.libi/storage/p1/clip.mp4",
    );

    fireEvent.click(screen.getByTestId("asset-location-reveal"));
    await waitFor(() => expect(revealFile).toHaveBeenCalledWith("/Users/x/.libi/storage/p1/clip.mp4"));
    expect(trackEvent).toHaveBeenCalledWith("asset_revealed", { source: "summary_tab" });
  });

  it("copies the path to the clipboard", async () => {
    locationResult.value = {
      data: { path: "/Users/x/.libi/storage/p1/clip.mp4", exists: true },
      isLoading: false,
    };
    render(<AssetLocationRow fileId="f1" />);

    fireEvent.click(screen.getByTestId("asset-location-copy"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("/Users/x/.libi/storage/p1/clip.mp4"),
    );
  });

  it("disables reveal but keeps copy when the file is gone from disk", () => {
    locationResult.value = {
      data: { path: "/Users/x/.libi/storage/p1/clip.mp4", exists: false },
      isLoading: false,
    };
    render(<AssetLocationRow fileId="f1" />);

    expect(screen.getByTestId("asset-location-reveal").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("asset-location-copy").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("asset-location-path").textContent).toBe(
      "/Users/x/.libi/storage/p1/clip.mp4",
    );
  });

  it("labels the reveal button with the platform-native wording", () => {
    locationResult.value = {
      data: { path: "/p/clip.mp4", exists: true },
      isLoading: false,
    };
    render(<AssetLocationRow fileId="f1" />);
    expect(screen.getByTestId("asset-location-reveal").getAttribute("title")).toBe(
      "Reveal in Finder",
    );
  });
});
