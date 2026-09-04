// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
        onClose={noop}
      />,
    );
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("reveals by id and reports the context_menu source when clicked", () => {
    render(
      <ResourceContextMenu
        state={state()}
        onRename={noop}
        onDelete={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByText("Reveal in Finder"));
    expect(revealFileById).toHaveBeenCalledWith("f1");
    expect(trackEvent).toHaveBeenCalledWith("asset_revealed", { source: "context_menu" });
  });

  it("does not show the reveal item for a piece", () => {
    render(
      <ResourceContextMenu
        state={state({ type: "piece", fileId: undefined })}
        onRename={noop}
        onDelete={noop}
        onClose={noop}
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
        onClose={noop}
      />,
    );
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });

  it("does not show the reveal item for an asset row with no fileId", () => {
    // Defensive: the menu needs an id to reveal by. Without one the row is
    // omitted rather than rendered inert.
    render(
      <ResourceContextMenu
        state={state({ fileId: undefined })}
        onRename={noop}
        onDelete={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
  });

  it("keeps Delete last among the destructive-adjacent items", () => {
    render(
      <ResourceContextMenu
        state={state()}
        onRename={noop}
        onDelete={noop}
        onClose={noop}
      />,
    );
    const labels = Array.from(document.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels.indexOf("Reveal in Finder")).toBeLessThan(labels.indexOf("Delete"));
  });
});
