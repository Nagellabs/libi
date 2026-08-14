// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OverlayEditor } from "@/components/preview/overlay-editor";
import type { TextOverlay } from "@/lib/engine/types";

function makeOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "ov1",
    kind: "text",
    content: "TILT TEST",
    font: "48px Inter",
    color: "#fff",
    align: "center",
    fontSize: 48,
    opacity: 1,
    rect: { x: 100, y: 100, width: 400, height: 80 },
    startTime: 0,
    duration: 2,
    z: 1,
    ...over,
  };
}

const baseProps = {
  compositionWidth: 1920,
  compositionHeight: 1080,
  canvasDisplayWidth: 480,
  canvasDisplayHeight: 270,
};

describe("OverlayEditor — content is uncontrolled (no clobber on external update)", () => {
  it("seeds the initial content on mount", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByTestId("overlay-editor").textContent).toBe("TILT TEST");
  });

  it("does NOT clobber an in-progress edit when the overlay's content changes externally", () => {
    const onCommit = vi.fn();
    const { getByTestId, rerender } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");

    // User edits the caption inline (the browser mutates the contentEditable DOM).
    editor.textContent = "TILT TEST EDITED";

    // An EXTERNAL update arrives mid-edit (e.g. an agent PATCH or another tool
    // changes the caption text) — the live composition refetches, so the editor
    // re-renders with a new overlay object whose `content` differs.
    rerender(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ content: "EXTERNAL CHANGE", fontSize: 64 })}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    // The user's in-progress edit MUST survive — React must not reconcile the
    // external content into the dirtied contentEditable.
    expect(editor.textContent).toBe("TILT TEST EDITED");

    // And committing on blur writes the user's text, not the external value.
    fireEvent.blur(editor);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("TILT TEST EDITED");
  });

  it("a style-only external re-render also leaves the edit intact", () => {
    const onCommit = vi.fn();
    const { getByTestId, rerender } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");
    editor.textContent = "EDIT IN PROGRESS";

    // Same content, different geometry (a handle drag committing fontSize/rect).
    rerender(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ fontSize: 96, rect: { x: 50, y: 50, width: 600, height: 120 } })}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    expect(editor.textContent).toBe("EDIT IN PROGRESS");
    fireEvent.blur(editor);
    expect(onCommit).toHaveBeenCalledWith("EDIT IN PROGRESS");
  });
});
