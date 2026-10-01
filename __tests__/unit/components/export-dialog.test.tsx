// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const exportDefaults: { data: unknown } = { data: undefined };
vi.mock("@/lib/queries/export-defaults", () => ({
  useExportDefaults: () => exportDefaults,
}));
const openExportInTab = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/exports/use-open-export", () => ({ openExportInTab }));

import { ExportDialog } from "@/components/export/export-dialog";
import { consumePostingIntent, isExportForPost, subscribePostingIntent } from "@/hooks/social/use-posting-intent";
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

// Spec 2026-09-29 §B2: Start queues the export and the dialog shows its form again — never a
// progress view; the export's own record carries progress (Exports tab, canvas bar, finish toast).
describe("ExportDialog — after Start", () => {
  const queuedFlow = () =>
    ({ ...idleFlow(), status: "queued", queued: { exportId: "exp_1", name: "My piece", pieceId: "p1" } }) as unknown as UseExportFlowResult;

  it("shows the form again with a queued banner, ready for another export", () => {
    const flow = queuedFlow();
    renderDialog({ hasDraft: true, hasSnapshot: false, flow });
    expect(screen.getByTestId("export-queued")).toHaveTextContent("Export queued — see the Exports tab");
    expect(screen.getByTestId("export-queued")).toHaveTextContent("My piece");
    // The form is still there, and Export is enabled: nothing blocks a second Start.
    expect(screen.getByDisplayValue("My piece")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Export another" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(flow.start).toHaveBeenCalledTimes(1);
  });

  it("links to the piece's Exports tab on that export, and closes", () => {
    const onOpenChange = vi.fn();
    render(
      <ExportDialog
        pieceId="p1"
        pieceName="My piece"
        compositionWidth={1920}
        compositionHeight={1080}
        flow={queuedFlow()}
        hasSnapshot={false}
        hasDraft
        openOverride
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the Exports tab" }));
    expect(openExportInTab).toHaveBeenCalledWith({ pieceId: "p1", exportId: "exp_1" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closing a queued dialog resets the flow, so the next open starts on a clean form", () => {
    const flow = queuedFlow();
    renderDialog({ hasDraft: true, hasSnapshot: false, flow });
    const footer = screen.getByRole("button", { name: "Export" }).parentElement as HTMLElement;
    fireEvent.click(within(footer).getByRole("button", { name: "Close" }));
    expect(flow.reset).toHaveBeenCalled();
  });

  describe("a social upload does not default to 4K", () => {
    const base = {
      pieceId: "p1", pieceName: "My piece", compositionWidth: 1080, compositionHeight: 1920, hasGraphics: true, hasSnapshot: false, hasDraft: true,
    };
    const dialog = (over: { openOverride: boolean; returnToPost: boolean }) => (
      <ExportDialog {...base} flow={idleFlow()} {...over} />
    );
    const selected = (field: HTMLElement) =>
      within(field).getAllByRole("button").find((b) => b.className.includes("bg-primary"))?.textContent;

    it("opened from the composer, Videos & images and Text, code & 3D start at 1080p, and the user can change them", () => {
      const { rerender } = render(dialog({ openOverride: false, returnToPost: true }));
      rerender(dialog({ openOverride: true, returnToPost: true }));
      expect(selected(mediaField())).toBe("1080p");
      expect(selected(graphicsField())).toBe("1080p");
      expect(screen.getByText("Output 1080×1920")).toBeInTheDocument();
      fireEvent.click(within(mediaField()).getByRole("button", { name: "4K" }));
      expect(selected(mediaField())).toBe("4K");
    });

    it("a WebM default is MP4 here (Instagram and TikTok want it), changeable, never saved, and back on the next plain open", () => {
      exportDefaults.data = { format: "webm", quality: "4k", graphicsQuality: "4k" };
      try {
        const { rerender } = render(dialog({ openOverride: false, returnToPost: true }));
        rerender(dialog({ openOverride: true, returnToPost: true }));
        expect(screen.getByRole("button", { name: "MP4" }).className).toContain("bg-primary");
        expect(screen.getByRole("button", { name: "WebM" }).className).not.toContain("bg-primary");
        fireEvent.click(screen.getByRole("button", { name: "WebM" }));
        expect(screen.getByRole("button", { name: "WebM" }).className).toContain("bg-primary");
        // The stored defaults object is untouched.
        expect(exportDefaults.data).toEqual({ format: "webm", quality: "4k", graphicsQuality: "4k" });
        rerender(dialog({ openOverride: false, returnToPost: false }));
        rerender(dialog({ openOverride: true, returnToPost: false }));
        expect(screen.getByRole("button", { name: "WebM" }).className).toContain("bg-primary");
      } finally {
        exportDefaults.data = undefined;
      }
    });

    it("the next ordinary open is back to what it was before the preset", () => {
      exportDefaults.data = { format: "mp4", quality: "4k", graphicsQuality: "4k" };
      try {
        const { rerender } = render(dialog({ openOverride: false, returnToPost: true }));
        rerender(dialog({ openOverride: true, returnToPost: true }));
        expect(selected(mediaField())).toBe("1080p");
        rerender(dialog({ openOverride: false, returnToPost: false }));
        rerender(dialog({ openOverride: true, returnToPost: false }));
        expect(selected(mediaField())).toBe("4K");
        expect(selected(graphicsField())).toBe("4K");
      } finally {
        exportDefaults.data = undefined;
      }
    });
  });

  describe("opened from the post composer", () => {
    const queued = { exportId: "exp_9", name: "My piece", pieceId: "p1" };

    function renderFromPost(returnToPost: boolean, started: unknown, returnDraftPostId: string | null = null) {
      const flow = idleFlow();
      flow.start.mockResolvedValue(started);
      const onOpenChange = vi.fn();
      const seen: Array<{ pieceId: string; awaitExportId?: string | null; providerPostId?: string | null }> = [];
      const off = subscribePostingIntent((i) => seen.push(i));
      render(
        <ExportDialog
          pieceId="p1"
          pieceName="My piece"
          compositionWidth={1920}
          compositionHeight={1080}
          flow={flow}
          hasSnapshot={false}
          hasDraft
          openOverride
          onOpenChange={onOpenChange}
          returnToPost={returnToPost}
          returnDraftPostId={returnDraftPostId}
        />,
      );
      return { flow, onOpenChange, seen, off };
    }

    it("after Start, hands the queued export to the Posting tab and closes", async () => {
      const { onOpenChange, seen, off } = renderFromPost(true, queued);
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(seen).toHaveLength(1));
      off();
      consumePostingIntent();
      expect(seen[0]).toMatchObject({ pieceId: "p1", awaitExportId: "exp_9" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      // …and remembers it was made for a post, so its finish toast can say "Continue post".
      expect(isExportForPost("exp_9")).toBe(true);
    });

    it("carries the draft being edited back to the Posting tab", async () => {
      const { seen, off } = renderFromPost(true, queued, "post_7");
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(seen).toHaveLength(1));
      off();
      consumePostingIntent();
      expect(seen[0]).toMatchObject({ pieceId: "p1", awaitExportId: "exp_9", providerPostId: "post_7" });
    });

    it("a refused Start stays in the dialog and goes nowhere", async () => {
      const { flow, onOpenChange, seen, off } = renderFromPost(true, null);
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(flow.start).toHaveBeenCalled());
      off();
      expect(seen).toEqual([]);
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("an ordinary open stays where it is after Start", async () => {
      const { flow, onOpenChange, seen, off } = renderFromPost(false, queued);
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(flow.start).toHaveBeenCalled());
      off();
      expect(seen).toEqual([]);
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  it("while the request is in flight, the button says Queuing… with a spinner and does not start again", () => {
    const flow = { ...idleFlow(), status: "starting" } as unknown as UseExportFlowResult & { start: ReturnType<typeof vi.fn> };
    renderDialog({ hasDraft: true, hasSnapshot: false, flow });
    const button = screen.getByRole("button", { name: "Queuing…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.querySelector("svg.animate-spin, svg[class*='animate-spin']")).not.toBeNull();
    fireEvent.click(button);
    expect(flow.start).not.toHaveBeenCalled();
  });

  it("a failed Start shows its error above the form", () => {
    const flow = { ...idleFlow(), status: "failed", error: "Composition cannot be exported" } as unknown as UseExportFlowResult;
    renderDialog({ hasDraft: true, hasSnapshot: false, flow });
    expect(screen.getByText("Composition cannot be exported")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My piece")).toBeInTheDocument();
  });

  it("shows no banner before anything is queued", () => {
    renderDialog({ hasDraft: true, hasSnapshot: false });
    expect(screen.queryByTestId("export-queued")).toBeNull();
  });
});
