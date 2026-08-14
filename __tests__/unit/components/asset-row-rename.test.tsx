// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AssetRow from "@/components/resources/asset-row";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * The rename input is seeded on the render where `isRenaming` turns on
 * (previous-state pattern); focus/select remain in an effect. The same
 * transformation was applied to FolderNode, PieceNode and AssetFolderRow —
 * this test pins the representative behavior.
 */

const file = {
  id: "f1",
  name: "My clip",
  filename: "clip.mp4",
  contentType: "video/mp4",
  size: 100,
  createdAt: new Date(),
  notes: null,
} as unknown as FileRecord;

function renderRow(isRenaming: boolean, handlers: Partial<{
  onRenameSubmit: (n: string) => void;
  onRenameCancel: () => void;
}> = {}) {
  return render(
    <AssetRow
      file={file}
      onSelect={() => {}}
      onContextMenu={() => {}}
      isRenaming={isRenaming}
      onRenameSubmit={handlers.onRenameSubmit ?? (() => {})}
      onRenameCancel={handlers.onRenameCancel ?? (() => {})}
    />,
  );
}

describe("AssetRow rename", () => {
  it("seeds the input with the display name and focuses it when renaming starts", () => {
    const { rerender } = renderRow(false);
    rerender(
      <AssetRow
        file={file}
        onSelect={() => {}}
        onContextMenu={() => {}}
        isRenaming={true}
        onRenameSubmit={() => {}}
        onRenameCancel={() => {}}
      />,
    );
    const input = screen.getByDisplayValue("My clip") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it("submits the trimmed new name on Enter", () => {
    const onRenameSubmit = vi.fn();
    renderRow(true, { onRenameSubmit });
    const input = screen.getByDisplayValue("My clip");
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameSubmit).toHaveBeenCalledWith("Renamed");
  });

  it("cancels when the name is unchanged", () => {
    const onRenameSubmit = vi.fn();
    const onRenameCancel = vi.fn();
    renderRow(true, { onRenameSubmit, onRenameCancel });
    fireEvent.keyDown(screen.getByDisplayValue("My clip"), { key: "Enter" });
    expect(onRenameSubmit).not.toHaveBeenCalled();
    expect(onRenameCancel).toHaveBeenCalled();
  });
});
