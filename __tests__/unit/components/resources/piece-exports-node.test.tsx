// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ExportRecordView } from "@/lib/exports/types";

const state = vi.hoisted(() => ({ data: [] as ExportRecordView[] }));
vi.mock("@/lib/queries/exports", () => ({ useExports: () => ({ data: state.data, isLoading: false }) }));
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
const openExportInTab = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/exports/use-open-export", () => ({ openExportInTab }));
const revealFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/shell/client", () => ({ revealFile, revealLabel: () => "Reveal in Finder", getShellPlatform: () => "darwin" }));
const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/client", () => ({ trackEvent }));

import PieceExportsNode from "@/components/resources/piece-exports-node";

const exp = (over: Partial<ExportRecordView>): ExportRecordView =>
  ({ id: "e", pieceId: "p1", name: "e", status: "done", missing: false, queuedAt: 0, completedAt: 0, path: "/s/p1/exports/e.mp4", fileName: "e.mp4", aspect: "9:16", ...over }) as ExportRecordView;

const FIRST = exp({ id: "first", name: "zeta", queuedAt: 1000, completedAt: 5000, path: "/s/p1/exports/zeta.mp4" });
const SECOND = exp({ id: "second", name: "alpha", queuedAt: 2000, completedAt: 3000, path: "/s/p1/exports/alpha.mp4" });
const names = () => screen.getAllByTestId(/^tree-export-/).map((el) => el.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  state.data = [FIRST, SECOND, exp({ id: "run", name: "running", status: "running", completedAt: null })];
});

describe("PieceExportsNode", () => {
  it("renders nothing for a piece without a done export", () => {
    state.data = [exp({ id: "run", status: "running", completedAt: null })];
    const { container } = render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists only done exports, by the panel's inner sort", () => {
    const { rerender } = render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    expect(names()).toEqual(["alpha", "zeta"]);
    rerender(<PieceExportsNode pieceId="p1" innerSort="created-asc" search="" />);
    expect(names()).toEqual(["zeta", "alpha"]);
    rerender(<PieceExportsNode pieceId="p1" innerSort="a-z" search="" />);
    expect(names()).toEqual(["alpha", "zeta"]);
  });

  it("a click opens the piece's Exports tab on that export", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.click(screen.getByTestId("tree-export-first"));
    expect(openExportInTab).toHaveBeenCalledWith({ pieceId: "p1", exportId: "first" });
  });

  it("right-click → Post… hands that export to the post composer", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.contextMenu(screen.getByTestId("tree-export-first"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Post…" }));
    expect(actions.post).toHaveBeenCalledWith(FIRST);
  });

  it("right-click on an export offers the shared actions", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.contextMenu(screen.getByTestId("tree-export-first"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(actions.copy).toHaveBeenCalledWith(FIRST);
  });

  it("right-click on the folder reveals the piece's exports folder", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Exports/ }), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(revealFile).toHaveBeenCalledWith("/s/p1/exports");
  });

  it("follows the panel's search, and hides when nothing matches", () => {
    const { rerender, container } = render(<PieceExportsNode pieceId="p1" innerSort="a-z" search="alp" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    expect(names()).toEqual(["alpha"]);
    rerender(<PieceExportsNode pieceId="p1" innerSort="a-z" search="nothing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renames inline from the menu", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.contextMenu(screen.getByTestId("tree-export-second"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Export name" });
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.rename).toHaveBeenCalledWith(SECOND, "beta");
  });

  it("deletes once however many times Delete is confirmed", () => {
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.contextMenu(screen.getByTestId("tree-export-first"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const confirm = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(actions.remove).toHaveBeenCalledTimes(1);
    expect(actions.remove).toHaveBeenCalledWith(FIRST);
  });
});
