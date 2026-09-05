// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// The sort menu is the whole subject here, so the tree's data layer is mocked
// down to the two things sorting actually reads: a piece's `name` and its
// `createdAt`. Everything else is a no-op stub — FileTree calls these hooks
// unconditionally at render, so they have to exist, but none of them
// participate in ordering.
// vi.hoisted: vi.mock factories are hoisted above every other statement, so
// anything they close over must be hoisted with them or it is still in its
// temporal dead zone when the mocked module is first imported.
const { mutation, piecesFixture } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => {}), isPending: false });
  const piece = (id: string, name: string, createdAt: string) => ({
    id,
    name,
    nameSetByUser: true,
    hasDraft: false,
    folderId: null,
    createdAt,
    updatedAt: createdAt,
    lastOpenedAt: null,
  });
  return {
    mutation,
    /**
     * Names and dates are deliberately "misaligned" — alphabetical order and
     * creation order are different permutations — so all four sort options
     * produce four DISTINCT orders. With aligned fixtures, a sort that
     * silently did nothing would still match two of the four expectations.
     */
    piecesFixture: [
      piece("p-banana", "Banana", "2026-01-03T00:00:00.000Z"),
      piece("p-apple", "Apple", "2026-01-02T00:00:00.000Z"),
      piece("p-cherry", "Cherry", "2026-01-01T00:00:00.000Z"),
    ],
  };
});

vi.mock("@/lib/queries/pieces", () => ({
  usePieces: () => ({ data: piecesFixture, isLoading: false }),
  useDeletePiece: mutation,
}));
vi.mock("@/lib/queries/folders", () => ({
  useFolders: () => ({ data: [], isLoading: false }),
  useCreateFolder: mutation,
  useRenameFolder: mutation,
  useMoveFolder: mutation,
  useMovePieceToFolder: mutation,
  useDeleteFolder: mutation,
}));
vi.mock("@/lib/queries/files", () => ({
  useDeleteFileById: mutation,
  useRenameFile: mutation,
  useAssignFile: mutation,
  useGlobalUpload: () => ({ upload: vi.fn() }),
  useGlobalFiles: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/queries/asset-folders", () => ({
  useAssetFolderList: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/queries/duplication", () => ({
  useDuplicatePiece: mutation,
  useDuplicateFolder: mutation,
  useDuplicatingPieceIds: () => new Set<string>(),
}));

import FileTree from "@/components/resources/file-tree";
import { ROOT_SORT_KEY } from "@/components/resources/sort-utils";

function renderTree() {
  return render(
    <FileTree
      activePieceId={null}
      onSelectPiece={() => {}}
      onSelectAsset={() => {}}
      onDeletePiece={() => {}}
    />,
  );
}

/** Rendered piece names, in DOM order. */
function renderedOrder(): string[] {
  return screen
    .getAllByText(/^(Apple|Banana|Cherry)$/)
    .map((el) => el.textContent ?? "");
}

/** Open the sort menu and choose `label` from the named section. */
function chooseSort(section: "Root" | "Inside pieces", label: string | RegExp) {
  fireEvent.click(screen.getByTitle("Sort"));
  const group = screen.getByRole("group", { name: section });
  fireEvent.click(within(group).getByRole("menuitem", { name: label }));
}

describe("resources panel sort menu", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens without crashing", () => {
    // The regression itself: DropdownMenuLabel outside a DropdownMenuGroup made
    // base-ui throw "MenuGroupRootContext is missing" while rendering the menu
    // content — so the menu died on the click that opened it, before any sort
    // option could be picked, and took the editor down with it.
    renderTree();
    expect(() => fireEvent.click(screen.getByTitle("Sort"))).not.toThrow();
    expect(screen.getByRole("group", { name: "Root" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Inside pieces" })).toBeTruthy();
  });

  it("defaults to newest first", () => {
    renderTree();
    expect(renderedOrder()).toEqual(["Banana", "Apple", "Cherry"]);
  });

  it("reorders for each of the four options", () => {
    renderTree();

    chooseSort("Root", "Oldest first");
    expect(renderedOrder()).toEqual(["Cherry", "Apple", "Banana"]);

    chooseSort("Root", /A\s*→\s*Z/);
    expect(renderedOrder()).toEqual(["Apple", "Banana", "Cherry"]);

    chooseSort("Root", /Z\s*→\s*A/);
    expect(renderedOrder()).toEqual(["Cherry", "Banana", "Apple"]);

    chooseSort("Root", "Newest first");
    expect(renderedOrder()).toEqual(["Banana", "Apple", "Cherry"]);
  });

  it("persists the chosen root sort", () => {
    renderTree();
    chooseSort("Root", /A\s*→\s*Z/);
    expect(localStorage.getItem(ROOT_SORT_KEY)).toBe("a-z");
  });

  it("keeps the two sections independent", () => {
    // Both sections list the same four labels. Choosing in "Inside pieces" must
    // not reorder the root tree — an early draft of this menu wired both
    // sections to the same handler and nothing caught it.
    renderTree();
    chooseSort("Inside pieces", /Z\s*→\s*A/);
    expect(renderedOrder()).toEqual(["Banana", "Apple", "Cherry"]);
    expect(localStorage.getItem(ROOT_SORT_KEY)).toBeNull();
  });
});
