// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The Assets grid keeps its OWN context menu rather than reusing the sidebar's
// ResourceContextMenu. This suite exists because that second surface was
// missed on the first pass: the reveal item shipped on the sidebar while a
// right-click in the grid still offered only "Move to root".

const revealFileById = vi.fn(async () => {});
vi.mock("@/lib/shell/client", () => ({
  revealFileById: (id: string) => revealFileById(id),
  revealFile: vi.fn(async () => {}),
  revealLabel: () => "Reveal in Finder",
  getShellPlatform: () => "darwin",
}));

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (n: string, p?: Record<string, unknown>) => trackEvent(n, p),
}));

const files = [
  {
    id: "f1",
    pieceId: "p1",
    folderId: null,
    name: "clip.mp4",
    filename: "clip.mp4",
    type: "video",
    contentType: "video/mp4",
    size: 10,
  },
];
const folders = [{ id: "d1", pieceId: "p1", parentFolderId: null, name: "audio" }];

vi.mock("@/lib/queries/asset-folders", () => ({
  useAssetLevel: () => ({ data: { folders, assets: files }, isLoading: false }),
  useAssetFolderList: () => ({ data: folders, isLoading: false }),
  useCreateAssetFolder: () => ({ mutateAsync: vi.fn() }),
  useRenameAssetFolder: () => ({ mutateAsync: vi.fn() }),
  useMoveAssetFolder: () => ({ mutateAsync: vi.fn() }),
  useDeleteAssetFolder: () => ({ mutateAsync: vi.fn() }),
  useMoveAsset: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ assetCurrentFolderId: null, setAssetCurrentFolderId: vi.fn() }),
}));

// Named export, not default.
import { AssetExplorer } from "@/components/editor/asset-explorer";

function openMenuOn(label: RegExp) {
  const target = screen.getByRole("button", { name: label });
  fireEvent.contextMenu(target, { clientX: 10, clientY: 10 });
}

describe("Assets grid context menu", () => {
  beforeEach(() => {
    revealFileById.mockClear();
    trackEvent.mockClear();
  });

  it("offers the reveal item on an asset", () => {
    render(<AssetExplorer pieceId="p1" onSelect={() => {}} />);
    openMenuOn(/Open clip\.mp4/i);
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("reveals by id and reports its own analytics source", () => {
    render(<AssetExplorer pieceId="p1" onSelect={() => {}} />);
    openMenuOn(/Open clip\.mp4/i);
    fireEvent.click(screen.getByText("Reveal in Finder"));

    expect(revealFileById).toHaveBeenCalledWith("f1");
    // A distinct source per surface — the enum stays bounded, and it is the
    // only way to tell whether anyone uses the grid's menu at all.
    expect(trackEvent).toHaveBeenCalledWith("asset_revealed", { source: "asset_grid" });
  });

  it("does not offer it on a folder, which has nothing on disk", () => {
    render(<AssetExplorer pieceId="p1" onSelect={() => {}} />);
    openMenuOn(/audio/i);
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    // …and the folder menu is genuinely open, so this isn't a false pass.
    expect(screen.getByText("Move to root")).toBeTruthy();
  });
});
