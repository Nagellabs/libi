// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddOverlayMenu } from "@/components/preview/add-overlay-menu";

const ctx = () => ({ startTime: 0, width: 1920, height: 1080, z: 1, totalDuration: 30 });

describe("AddOverlayMenu", () => {
  it("itemClass constant includes a clearly-visible hover token and focus-visible state", () => {
    // Instead of asserting on DOM, we import the module and check the className
    // constant used for item buttons is correctly set.
    // We verify this by checking one of the item buttons directly.
    render(
      <AddOverlayMenu
        resolveCtx={ctx}
        pieceId="p1"
        onCreateDirect={() => {}}
        onPickAsset={() => {}}
        onAskAgent={() => {}}
        trigger={<button>+ Add</button>}
      />,
    );
    // Open the menu
    fireEvent.click(screen.getByText("+ Add"));
    // Find the Text menu item button (rendered inside the popover)
    const textBtn = screen.queryByText("Text")?.closest("button");
    expect(textBtn).not.toBeNull();
    const cls = textBtn!.className;
    // Must have a visible hover background (not the near-invisible `hover:bg-accent`)
    expect(cls).toMatch(/hover:bg-white\/10|hover:bg-muted/);
    // Must have focus-visible state
    expect(cls).toMatch(/focus-visible:/);
  });

  it("text → onCreateDirect with a text payload", () => {
    const onCreateDirect = vi.fn();
    render(<AddOverlayMenu resolveCtx={ctx} pieceId="p1" onCreateDirect={onCreateDirect} onPickAsset={() => {}} onAskAgent={() => {}} trigger={<button>+ Add</button>} />);
    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.click(screen.getByText("Text"));
    expect(onCreateDirect).toHaveBeenCalledWith(expect.objectContaining({ kind: "text", content: "New text" }));
  });

  it("image → onPickAsset('image')", () => {
    const onPickAsset = vi.fn();
    render(<AddOverlayMenu resolveCtx={ctx} pieceId="p1" onCreateDirect={() => {}} onPickAsset={onPickAsset} onAskAgent={() => {}} trigger={<button>+ Add</button>} />);
    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.click(screen.getByText("Image"));
    expect(onPickAsset).toHaveBeenCalledWith("image");
  });

  it("3D → onAskAgent('three')", () => {
    const onAskAgent = vi.fn();
    render(<AddOverlayMenu resolveCtx={ctx} pieceId="p1" onCreateDirect={() => {}} onPickAsset={() => {}} onAskAgent={onAskAgent} trigger={<button>+ Add</button>} />);
    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.click(screen.getByText("3D"));
    expect(onAskAgent).toHaveBeenCalledWith("three");
  });
});
