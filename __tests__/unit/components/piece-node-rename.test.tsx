// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/resources/piece-assets", () => ({
  default: () => <div data-testid="piece-assets" />,
}));

import PieceNode from "@/components/resources/piece-node";
import type { PieceSummary } from "@/lib/queries/pieces";

/**
 * The context-menu rename trigger now seeds + opens the inline input DURING
 * RENDER (self-limiting adjustment), while acknowledging the trigger — a
 * PARENT setState — stays in an effect. These tests pin the observable
 * contract: trigger → focused input seeded with the piece name → ack fired.
 */

const piece = { id: "p1", name: "My piece", updatedAt: new Date().toISOString() } as unknown as PieceSummary;

function renderNode(triggerRename: boolean, onRenameTriggerHandled = vi.fn(), onRenamePiece = vi.fn()) {
  const utils = render(
    <PieceNode
      piece={piece}
      isActive={false}
      isExpanded={false}
      onToggleExpand={() => {}}
      onSelectPiece={() => {}}
      onSelectAsset={() => {}}
      onRenamePiece={onRenamePiece}
      onContextMenu={() => {}}
      renamingFileId={null}
      onRenameFileSubmit={() => {}}
      onRenameFileCancel={() => {}}
      triggerRename={triggerRename}
      onRenameTriggerHandled={onRenameTriggerHandled}
      innerSort="name"
      search=""
    />,
  );
  return { ...utils, onRenameTriggerHandled, onRenamePiece };
}

describe("PieceNode external rename trigger", () => {
  it("opens the seeded, focused rename input and acks the trigger", () => {
    const { onRenameTriggerHandled } = renderNode(true);
    const input = screen.getByDisplayValue("My piece") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(onRenameTriggerHandled).toHaveBeenCalled();
  });

  it("submits the new name on Enter", () => {
    const { onRenamePiece } = renderNode(true);
    const input = screen.getByDisplayValue("My piece");
    fireEvent.change(input, { target: { value: "Renamed piece" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenamePiece).toHaveBeenCalledWith("Renamed piece");
  });

  it("shows no input without a trigger", () => {
    renderNode(false);
    expect(screen.queryByDisplayValue("My piece")).not.toBeInTheDocument();
  });
});
