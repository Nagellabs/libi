// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const exportDefaults: { data: unknown } = { data: undefined };
vi.mock("@/lib/queries/export-defaults", () => ({
  useExportDefaults: () => exportDefaults,
}));
vi.mock("@/lib/shell/client", () => ({
  revealFile: vi.fn(),
  pickDirectory: vi.fn(async () => undefined),
  hasElectronBridge: () => false,
}));

import { ExportDialog } from "@/components/export/export-dialog";
import type { UseExportFlowResult } from "@/hooks/editor/use-export-flow";

/**
 * The form seeds via lazy initializers (source default, filename, defaults)
 * with previous-state blocks folding in later changes — replacing the old
 * mount effects. These tests pin the seeded initial form.
 */

function idleFlow(): UseExportFlowResult {
  return {
    status: "idle",
    progress: null,
    result: null,
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  } as unknown as UseExportFlowResult;
}

function renderDialog(opts: { hasDraft: boolean; hasSnapshot: boolean; pieceName?: string }) {
  return render(
    <ExportDialog
      pieceId="p1"
      pieceName={opts.pieceName ?? "My piece"}
      compositionWidth={1920}
      compositionHeight={1080}
      flow={idleFlow()}
      hasSnapshot={opts.hasSnapshot}
      hasDraft={opts.hasDraft}
      openOverride
    />,
  );
}

describe("ExportDialog form seeding", () => {
  it("seeds the filename from the piece name", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true });
    expect(screen.getByDisplayValue("My piece")).toBeInTheDocument();
  });

  it("defaults the source to snapshot when there is no draft (at mount)", () => {
    renderDialog({ hasDraft: false, hasSnapshot: true });
    // The selected Segmented chip carries the bg-primary treatment.
    expect(screen.getByRole("button", { name: "Snapshot" }).className).toContain("bg-primary");
    expect(screen.getByRole("button", { name: "Draft" }).className).not.toContain("bg-primary");
  });

  it("defaults the source to draft when a draft exists", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true });
    expect(screen.getByRole("button", { name: "Draft" }).className).toContain("bg-primary");
  });

  it("seeds format/quality from the export defaults when already loaded", () => {
    exportDefaults.data = {
      format: "webm",
      quality: "1080p",
      folder: "/tmp/exports",
      effectiveFolder: "/tmp/exports",
    };
    renderDialog({ hasDraft: true, hasSnapshot: true });
    // The seeded format renders as the selected Segmented chip.
    expect(screen.getByRole("button", { name: "WebM" }).className).toContain("bg-primary");
    exportDefaults.data = undefined;
  });
});
