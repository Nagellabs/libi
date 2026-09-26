// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const exportDefaults: { data: unknown } = { data: undefined };
vi.mock("@/lib/queries/export-defaults", () => ({
  useExportDefaults: () => exportDefaults,
}));
vi.mock("@/lib/shell/client", () => ({
  revealFile: vi.fn(),
  pickDirectory: vi.fn(async () => undefined),
  hasElectronBridge: () => false,
}));

const socialStatus: { data: { providerId: string | null } | undefined } = { data: { providerId: "zernio" } };
vi.mock("@/lib/queries/social", () => ({
  useSocialStatus: () => socialStatus,
}));

const { openPostingTab } = vi.hoisted(() => ({ openPostingTab: vi.fn() }));
vi.mock("@/hooks/social/use-posting-intent", () => ({
  openPostingTab,
}));

import { ExportDialog } from "@/components/export/export-dialog";
import type { UseExportFlowResult } from "@/hooks/editor/use-export-flow";

const RESULT = {
  filePath: "/exports/my-piece.mp4",
  sizeBytes: 1_234_567,
  durationSeconds: 12,
  backend: "stream-copy-trim",
  width: 1080,
  height: 1920,
};

function successFlow(): UseExportFlowResult {
  return {
    status: "success",
    progress: null,
    result: RESULT,
    error: null,
    jobId: "job_1",
    start: vi.fn(),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(),
  } as unknown as UseExportFlowResult;
}

function renderSuccess(onOpenChange = vi.fn()) {
  return {
    onOpenChange,
    ...render(
      <ExportDialog
        pieceId="p1"
        pieceName="My piece"
        compositionWidth={1080}
        compositionHeight={1920}
        flow={successFlow()}
        hasSnapshot
        hasDraft
        openOverride
        onOpenChange={onOpenChange}
      />,
    ),
  };
}

describe("ExportDialog success view — Post…", () => {
  beforeEach(() => {
    socialStatus.data = { providerId: "zernio" };
    openPostingTab.mockClear();
  });

  it("renders a Post… button beside 'Show in folder' when social posting is set up", () => {
    renderSuccess();
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
    expect(screen.getByTestId("export-post-button")).toBeInTheDocument();
    expect(screen.queryByTestId("export-setup-social")).toBeNull();
  });

  it("clicking Post… calls openPostingTab({ pieceId, exportPath }) and closes the dialog", () => {
    const onOpenChange = vi.fn();
    renderSuccess(onOpenChange);
    fireEvent.click(screen.getByTestId("export-post-button"));
    expect(openPostingTab).toHaveBeenCalledWith({ pieceId: "p1", exportPath: RESULT.filePath });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reads 'Set up social posting' and links to /social when there is no provider", () => {
    socialStatus.data = { providerId: null };
    renderSuccess();
    expect(screen.queryByTestId("export-post-button")).toBeNull();
    const link = screen.getByTestId("export-setup-social");
    expect(link).toHaveTextContent("Set up social posting");
    expect(link).toHaveAttribute("href", "/social");
  });

  it("renders neither control while social status hasn't loaded yet", () => {
    socialStatus.data = undefined;
    renderSuccess();
    expect(screen.queryByTestId("export-post-button")).toBeNull();
    expect(screen.queryByTestId("export-setup-social")).toBeNull();
  });
});
