// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ExportRecordView } from "@/lib/exports/types";

/**
 * "Post…" end to end through the REAL actions hook: the menu item on the
 * Exports tab and on the resources panel's Exports folder opens the piece's
 * Posting tab with the composer started on THAT export's file (spec P4), and
 * a missing file never gets there.
 */
const state = vi.hoisted(() => ({ data: [] as ExportRecordView[] }));
vi.mock("@/lib/queries/exports", () => ({
  useExports: () => ({ data: state.data, isLoading: false }),
  fetchExportLocation: vi.fn(),
  useRenameExport: () => ({ mutateAsync: vi.fn() }),
  useDeleteExport: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/shell/client", () => ({
  copyFileToClipboard: vi.fn(),
  revealFile: vi.fn(),
  revealLabel: () => "Reveal in Finder",
  getShellPlatform: () => "darwin",
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/client", () => ({ trackEvent }));
vi.mock("@/hooks/exports/use-open-export", () => ({ openExportInTab: vi.fn() }));
vi.mock("@/components/editor/asset-media-view", () => ({ MediaSrcView: () => <div /> }));

import { ExportsTab } from "@/components/editor/exports-tab";
import PieceExportsNode from "@/components/resources/piece-exports-node";
import { consumePostingIntent, subscribePostingIntent, type PostingIntent } from "@/hooks/social/use-posting-intent";

const exp = (over: Partial<ExportRecordView>): ExportRecordView =>
  ({
    id: "e", pieceId: "p1", pieceName: "Piece", name: "e", fileName: "e.mp4", path: "/s/p1/exports/e.mp4", status: "done", missing: false,
    error: null, queuedAt: 1, startedAt: 1, completedAt: 2, sizeBytes: 1024, durationSec: 5, width: 1080, height: 1920, aspect: "9:16",
    container: "mp4", carriesCopyrighted: false, excludedFileIds: [], progress: null, waiting: null, ...over,
  }) as ExportRecordView;

let seen: PostingIntent[] = [];
let off: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  off = subscribePostingIntent((i) => seen.push(i));
  localStorage.clear();
});
afterEach(() => {
  off();
  consumePostingIntent();
});

describe("Post… on an export", () => {
  it("the Exports tab row menu opens the Posting tab on that export", () => {
    state.data = [exp({ id: "a", name: "A cut", path: "/s/p1/exports/a-cut.mp4" })];
    render(<ExportsTab pieceId="p1" selectedExportId={null} onSelectExport={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for A cut" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Post…" }));
    expect(seen).toEqual([expect.objectContaining({ pieceId: "p1", exportPath: "/s/p1/exports/a-cut.mp4" })]);
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "post", surface: "tab" });
  });

  it("the resources Exports folder menu does the same, tracked as the resources surface", () => {
    state.data = [exp({ id: "b", name: "B cut", path: "/s/p1/exports/b-cut.mp4" })];
    render(<PieceExportsNode pieceId="p1" innerSort="created-desc" search="" />);
    fireEvent.click(screen.getByRole("button", { name: /Exports/ }));
    fireEvent.contextMenu(screen.getByTestId("tree-export-b"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Post…" }));
    expect(seen).toEqual([expect.objectContaining({ pieceId: "p1", exportPath: "/s/p1/exports/b-cut.mp4" })]);
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "post", surface: "resources" });
  });

  it("a missing file has no Post… item", () => {
    state.data = [exp({ id: "m", name: "Gone", missing: true })];
    render(<ExportsTab pieceId="p1" selectedExportId={null} onSelectExport={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Gone" }));
    expect(screen.queryByRole("menuitem", { name: "Post…" })).toBeNull();
    expect(seen).toEqual([]);
  });
});
