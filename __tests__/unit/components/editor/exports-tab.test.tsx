// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ExportRecordView } from "@/lib/exports/types";

const state = vi.hoisted(() => ({ data: undefined as ExportRecordView[] | undefined, isLoading: false }));
vi.mock("@/lib/queries/exports", () => ({ useExports: () => state }));
const actions = vi.hoisted(() => ({
  revealLabel: "Reveal in Finder",
  reveal: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
  post: vi.fn(),
  rename: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  played: vi.fn(),
}));
vi.mock("@/hooks/exports/use-export-actions", () => ({ useExportActions: () => actions }));
const requestExportDialog = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/social/use-posting-intent", () => ({ requestExportDialog }));
vi.mock("@/components/editor/asset-media-view", () => ({
  MediaSrcView: ({ src }: { src: string }) => <div data-testid="player" data-src={src} />,
}));

import { ExportsTab, EXPORTS_LAYOUT, SIDE_BY_SIDE_MIN_PX } from "@/components/editor/exports-tab";

const exp = (over: Partial<ExportRecordView>): ExportRecordView =>
  ({
    id: "e", pieceId: "p1", pieceName: "Piece", jobId: null, name: "e", fileName: "e.mp4", path: "/s/p1/exports/e.mp4",
    status: "done", missing: false, error: null, queuedAt: 0, startedAt: 0, completedAt: 0, sizeBytes: 1024 * 1024,
    durationSec: 12, width: 1080, height: 1920, aspect: "9:16", container: "mp4", codec: "avc", fps: 30, quality: "source",
    graphicsQuality: "4k", purpose: null, carriesCopyrighted: false, excludedFileIds: [], backend: "ffmpeg-overlay",
    droppedOverlays: null, source: "user", progress: null, waiting: null, ...over,
  }) as ExportRecordView;

const OLD = exp({ id: "old", name: "Old cut", queuedAt: 1000, completedAt: 5000, aspect: "16:9", width: 1920, height: 1080 });
const NEW = exp({ id: "new", name: "new cut", queuedAt: 2000, completedAt: 3000 });
const onSelect = vi.fn();
const renderTab = (selected: string | null = null) => render(<ExportsTab pieceId="p1" selectedExportId={selected} onSelectExport={onSelect} />);
const rowNames = () => within(screen.getByRole("list", { name: "Exports" })).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.data = [NEW, OLD];
  state.isLoading = false;
});

describe("ExportsTab", () => {
  it("shows skeleton rows while loading", () => {
    state.isLoading = true;
    state.data = undefined;
    renderTab();
    expect(screen.getByTestId("exports-skeleton")).toBeInTheDocument();
  });

  it("empty: says so and offers the Export button", () => {
    state.data = [];
    renderTab();
    expect(screen.getByText("No exports yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(requestExportDialog).toHaveBeenCalledWith("p1");
  });

  it("sorts oldest first by default, and remembers another choice", () => {
    renderTab();
    expect(rowNames()).toEqual(["export-row-old", "export-row-new"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort exports" }), { target: { value: "time-desc" } });
    expect(rowNames()).toEqual(["export-row-new", "export-row-old"]);
    expect(localStorage.getItem("libi:exports-sort")).toBe("time-desc");
  });

  it("sorts by when the export was queued, not when it finished; a running row sorts by its queue time", () => {
    const first = exp({ id: "one", name: "Batch 1", queuedAt: 100, completedAt: 900 });
    const second = exp({ id: "two", name: "Batch 2", queuedAt: 200, completedAt: 500 });
    const third = exp({ id: "three", name: "Batch 3", queuedAt: 300, completedAt: null, status: "running" });
    state.data = [third, second, first];
    renderTab();
    expect(rowNames()).toEqual(["export-row-one", "export-row-two", "export-row-three"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort exports" }), { target: { value: "time-desc" } });
    expect(rowNames()).toEqual(["export-row-three", "export-row-two", "export-row-one"]);
  });

  it("a done row's date is when it was queued", () => {
    const queuedAt = new Date(2026, 8, 29, 10, 15).getTime();
    state.data = [exp({ id: "d", name: "D", queuedAt, completedAt: new Date(2026, 8, 30, 18, 45).getTime() })];
    renderTab();
    const row = screen.getByTestId("export-row-d");
    expect(within(row).getByText(new Date(queuedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))).toBeInTheDocument();
  });

  describe("responsive layout (container query, asserted as a class contract — jsdom cannot measure one)", () => {
    it("the root is the query container; the frame stacks by default and goes side by side from the list + player minimum width", () => {
      renderTab();
      expect(screen.getByTestId("exports-tab").parentElement?.className).toContain("@container");
      const frame = screen.getByTestId("exports-tab").className;
      expect(frame).toContain("flex-col");
      expect(frame).toContain(`@[${SIDE_BY_SIDE_MIN_PX}px]:flex-row`);
      expect(EXPORTS_LAYOUT.frame).toContain(`@[${SIDE_BY_SIDE_MIN_PX}px]:flex-row`);
    });

    it("narrow: the player is first (above the list) at full width; wide: it moves back after the list with a minimum width", () => {
      renderTab();
      const player = screen.getByTestId("exports-player").className;
      expect(player).toContain("order-first");
      expect(player).toContain("w-full");
      expect(player).toContain(`@[${SIDE_BY_SIDE_MIN_PX}px]:order-none`);
      expect(player).toContain("@[700px]:min-w-[320px]");
      const list = screen.getByTestId("exports-list").className;
      expect(list).toContain("w-full");
      expect(list).toContain("@[700px]:w-[380px]");
    });

    it("the empty-selection hint sits in the full-width player slot, not a sliver", () => {
      renderTab();
      const player = screen.getByTestId("exports-player");
      expect(within(player).getByText("Select an export to play it.")).toBeInTheDocument();
    });
  });

  it("uses a remembered sort at mount", () => {
    localStorage.setItem("libi:exports-sort", "time-desc");
    renderTab();
    expect(rowNames()).toEqual(["export-row-new", "export-row-old"]);
  });

  it("filters by the aspects present and by name", () => {
    renderTab();
    const chips = within(screen.getByRole("group", { name: "Filter by aspect" })).getAllByRole("button").map((b) => b.textContent);
    expect(chips).toEqual(["All", "9:16", "16:9"]);
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    expect(rowNames()).toEqual(["export-row-old"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search exports" }), { target: { value: "NEW" } });
    expect(rowNames()).toEqual(["export-row-new"]);
  });

  it("a done row shows its facts; selecting it plays it", () => {
    state.data = [exp({ id: "a", name: "A", carriesCopyrighted: true })];
    const { rerender } = renderTab();
    const row = screen.getByTestId("export-row-a");
    expect(within(row).getByText("9:16")).toBeInTheDocument();
    expect(within(row).getByText("1.0 MB")).toBeInTheDocument();
    expect(within(row).getByText("0:12")).toBeInTheDocument();
    expect(within(row).getByText("Copyrighted music")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "A" }));
    expect(onSelect).toHaveBeenCalledWith("a");
    rerender(<ExportsTab pieceId="p1" selectedExportId="a" onSelectExport={onSelect} />);
    expect(screen.getByTestId("player")).toHaveAttribute("data-src", "/api/exports/a/content");
  });

  it("a running row shows why it waits and can be cancelled", () => {
    const running = exp({ id: "r", name: "R", status: "running", completedAt: null, waiting: { reason: "memory", message: "Waiting for memory — 2 exports running" } });
    state.data = [running];
    renderTab();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for memory — 2 exports running");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.remove).toHaveBeenCalledWith(running);
  });

  it("a failed row shows the error and can be dismissed", () => {
    const failed = exp({ id: "f", name: "F", status: "failed", error: "Composition cannot be exported: nothing to export" });
    state.data = [failed];
    renderTab();
    expect(screen.getByText("Composition cannot be exported: nothing to export")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(actions.remove).toHaveBeenCalledWith(failed);
  });

  it("a missing file says so and never plays; cancelled exports are not listed", () => {
    state.data = [exp({ id: "m", name: "M", missing: true }), exp({ id: "c", name: "C", status: "cancelled" })];
    renderTab("m");
    expect(within(screen.getByTestId("export-row-m")).getByText("Missing file")).toBeInTheDocument();
    expect(screen.queryByTestId("player")).toBeNull();
    expect(screen.queryByTestId("export-row-c")).toBeNull();
  });

  it("the row menu renames inline", () => {
    state.data = [OLD];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Old cut" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Export name" });
    fireEvent.change(input, { target: { value: "Final cut" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.rename).toHaveBeenCalledWith(OLD, "Final cut");
  });

  it("the row menu's Post… hands that export to the post composer", () => {
    state.data = [OLD];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Old cut" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Post…" }));
    expect(actions.post).toHaveBeenCalledWith(OLD);
  });

  it("a confirmed delete closes the dialog at once and deletes once, even on a double click", () => {
    state.data = [OLD];
    renderTab("old");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Old cut" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const confirm = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(actions.remove).toHaveBeenCalledTimes(1);
    expect(actions.remove).toHaveBeenCalledWith(OLD);
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(screen.queryByText("Delete this export?")).toBeNull();
  });
});
