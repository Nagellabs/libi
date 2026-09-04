// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/shell/client", () => ({
  revealLabel: () => "Reveal in Finder",
  getShellPlatform: () => "darwin",
}));

import ResourceContextMenu, { type ContextMenuState } from "@/components/resources/context-menu";

function state(overrides: Partial<ContextMenuState> = {}): ContextMenuState {
  return {
    x: 10,
    y: 10,
    type: "asset",
    pieceId: "p1",
    fileId: "f1",
    name: "clip.mp4",
    ...overrides,
  };
}

const noop = () => {};

describe("ResourceContextMenu reveal item", () => {
  it("shows the reveal item for an asset", () => {
    render(
      <ResourceContextMenu
        state={state()}
        onRename={noop}
        onDelete={noop}
        onReveal={noop}
      />,
    );
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("calls onReveal when the item is clicked", () => {
    const onReveal = vi.fn();
    render(
      <ResourceContextMenu
        state={state()}
        onRename={noop}
        onDelete={noop}
        onReveal={onReveal}
      />,
    );
    fireEvent.click(screen.getByText("Reveal in Finder"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("does not show the reveal item for a piece", () => {
    render(
      <ResourceContextMenu
        state={state({ type: "piece", fileId: undefined })}
        onRename={noop}
        onDelete={noop}
        onReveal={noop}
      />,
    );
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });

  it("does not show the reveal item for a folder", () => {
    render(
      <ResourceContextMenu
        state={state({ type: "folder", fileId: undefined, folderId: "d1" })}
        onRename={noop}
        onDelete={noop}
        onReveal={noop}
      />,
    );
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });

  it("does not show the reveal item when no handler is supplied", () => {
    render(<ResourceContextMenu state={state()} onRename={noop} onDelete={noop} />);
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });

  it("keeps Delete last among the destructive-adjacent items", () => {
    render(
      <ResourceContextMenu
        state={state()}
        onRename={noop}
        onDelete={noop}
        onReveal={noop}
      />,
    );
    const labels = Array.from(document.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels.indexOf("Reveal in Finder")).toBeLessThan(labels.indexOf("Delete"));
  });
});
