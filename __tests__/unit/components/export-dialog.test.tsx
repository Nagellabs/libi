// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

function idleFlow(): UseExportFlowResult & { start: ReturnType<typeof vi.fn> } {
  return {
    status: "idle",
    progress: null,
    result: null,
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  } as unknown as UseExportFlowResult & { start: ReturnType<typeof vi.fn> };
}

function renderDialog(opts: {
  hasDraft: boolean;
  hasSnapshot: boolean;
  pieceName?: string;
  compositionWidth?: number;
  compositionHeight?: number;
  hasGraphics?: boolean;
  flow?: UseExportFlowResult;
}) {
  const flow = opts.flow ?? idleFlow();
  const view = render(
    <ExportDialog
      pieceId="p1"
      pieceName={opts.pieceName ?? "My piece"}
      compositionWidth={opts.compositionWidth ?? 1920}
      compositionHeight={opts.compositionHeight ?? 1080}
      hasGraphics={opts.hasGraphics}
      flow={flow}
      hasSnapshot={opts.hasSnapshot}
      hasDraft={opts.hasDraft}
      openOverride
    />,
  );
  return { ...view, flow };
}

/** The "Videos & images" row's Segmented control, scoped so its "1080p"/
 *  "1440p"/"4K" buttons don't collide with the "Text, code & 3D" row's
 *  identically-labelled buttons when both render. */
function mediaField(): HTMLElement {
  return screen.getByText("Videos & images").closest("div")!.parentElement as HTMLElement;
}
function graphicsField(): HTMLElement {
  return screen.getByText("Text, code & 3D").closest("div")!.parentElement as HTMLElement;
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
      graphicsQuality: "1440p",
      folder: "/tmp/exports",
      effectiveFolder: "/tmp/exports",
    };
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    // The seeded format renders as the selected Segmented chip.
    expect(screen.getByRole("button", { name: "WebM" }).className).toContain("bg-primary");
    expect(within(mediaField()).getByRole("button", { name: "1080p" }).className).toContain(
      "bg-primary",
    );
    expect(within(graphicsField()).getByRole("button", { name: "1440p" }).className).toContain(
      "bg-primary",
    );
    exportDefaults.data = undefined;
  });
});

describe("ExportDialog defaults with no stored settings", () => {
  it("selects Original for videos & images and 4K for text, code & 3D", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    expect(within(mediaField()).getByRole("button", { name: "Original" }).className).toContain(
      "bg-primary",
    );
    expect(within(graphicsField()).getByRole("button", { name: "4K" }).className).toContain(
      "bg-primary",
    );
  });
});

describe("ExportDialog graphics row visibility", () => {
  it("does not render the graphics row when hasGraphics is false", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: false });
    expect(screen.queryByText("Text, code & 3D")).not.toBeInTheDocument();
  });

  it("renders the graphics row when hasGraphics is true", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    expect(screen.getByText("Text, code & 3D")).toBeInTheDocument();
  });
});

describe("ExportDialog graphics warning", () => {
  it("shows no warning at 4K (the default)", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    expect(
      screen.queryByText(/Text, code and 3D may look less sharp/),
    ).not.toBeInTheDocument();
  });

  it("shows the warning at 1080p", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1080p" }));
    expect(screen.getByText(/Text, code and 3D may look less sharp/)).toBeInTheDocument();
  });

  it("shows the warning at 1440p", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1440p" }));
    expect(screen.getByText(/Text, code and 3D may look less sharp/)).toBeInTheDocument();
  });

  it("shows no warning when media at 4K already makes the output 4K", () => {
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true });
    fireEvent.click(within(mediaField()).getByRole("button", { name: "4K" }));
    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1080p" }));
    expect(
      screen.queryByText(/Text, code and 3D may look less sharp/),
    ).not.toBeInTheDocument();
  });
});

describe("ExportDialog media upscaling warning", () => {
  // The media warning fires only when the MEDIA choice itself upscales past
  // the composition — never merely because the graphics tier is larger.
  it("does not fire when only the graphics tier drives the output up", () => {
    renderDialog({
      hasDraft: true,
      hasSnapshot: true,
      hasGraphics: true,
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
    // Media stays at Original (no upscale); graphics defaults to 4K, which
    // is larger than the 1080x1920 composition and drives the output up —
    // but that must not trigger the MEDIA upscaling copy.
    expect(
      screen.queryByText(/Videos and images are upscaled/),
    ).not.toBeInTheDocument();
  });

  it("fires when the media choice itself upscales past the composition", () => {
    renderDialog({
      hasDraft: true,
      hasSnapshot: true,
      compositionWidth: 640,
      compositionHeight: 360,
    });
    fireEvent.click(within(mediaField()).getByRole("button", { name: "4K" }));
    expect(screen.getByText(/Videos and images are upscaled from 640×360/)).toBeInTheDocument();
  });
});

describe("ExportDialog output hint", () => {
  it("shows the resolved output size using resolveOutputDimensions", () => {
    renderDialog({
      hasDraft: true,
      hasSnapshot: true,
      hasGraphics: true,
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
    // media=Original (1080x1920), graphics defaults to 4K (2160x3840) — the
    // larger of the two wins the output frame.
    expect(screen.getByText("Output 2160×3840")).toBeInTheDocument();
  });
});

describe("ExportDialog start payload", () => {
  it("carries graphicsQuality to flow.start", () => {
    const flow = idleFlow();
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: true, flow });
    fireEvent.click(within(graphicsField()).getByRole("button", { name: "1440p" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(flow.start).toHaveBeenCalledWith(
      expect.objectContaining({ quality: "source", graphicsQuality: "1440p" }),
    );
  });

  it("still sends graphicsQuality when hasGraphics is false (server ignores it)", () => {
    const flow = idleFlow();
    renderDialog({ hasDraft: true, hasSnapshot: true, hasGraphics: false, flow });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(flow.start).toHaveBeenCalledWith(
      expect.objectContaining({ graphicsQuality: "4k" }),
    );
  });
});

describe("ExportDialog quality hint — orientation-aware presets", () => {
  // Regression for the bug where the dialog derived the "1080p" hint from a
  // hardcoded landscape table (1920×1080) instead of the server's short-edge
  // logic. For a portrait piece (the DEFAULT for new pieces, which are
  // 9:16), that showed the wrong dimensions AND a false upscaling warning
  // for an export that is pixel-identical to the source.
  it("shows the portrait target dimensions, not the landscape table", () => {
    renderDialog({
      hasDraft: true,
      hasSnapshot: true,
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
    fireEvent.click(within(mediaField()).getByRole("button", { name: "1080p" }));
    expect(screen.getByText("Output 1080×1920")).toBeInTheDocument();
  });

  it("shows no upscaling warning for a 1080×1920 piece at 1080p", () => {
    renderDialog({
      hasDraft: true,
      hasSnapshot: true,
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
    fireEvent.click(within(mediaField()).getByRole("button", { name: "1080p" }));
    expect(screen.queryByText(/Videos and images are upscaled/)).not.toBeInTheDocument();
  });
});
