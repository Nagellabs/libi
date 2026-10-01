// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExportContextMenu } from "@/components/exports/export-context-menu";
import { ExportDeleteDialog } from "@/components/exports/export-delete-dialog";
import type { ExportRecordView } from "@/lib/exports/types";

const EXP = { id: "exp_1", name: "Promo", fileName: "Promo.mp4", missing: false, status: "done" } as ExportRecordView;

function renderMenu(exp: ExportRecordView = EXP) {
  const cb = { onPost: vi.fn(), onReveal: vi.fn(), onCopy: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onClose: vi.fn() };
  render(<ExportContextMenu state={{ x: 10, y: 10, exp }} revealLabel="Reveal in Finder" {...cb} />);
  return cb;
}

describe("ExportContextMenu", () => {
  it("offers post, reveal, copy, rename and delete for a finished export", () => {
    const cb = renderMenu();
    for (const [label, fn] of [
      ["Post…", cb.onPost],
      ["Reveal in Finder", cb.onReveal],
      ["Copy", cb.onCopy],
      ["Rename", cb.onRename],
      ["Delete…", cb.onDelete],
    ] as const) {
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(fn).toHaveBeenCalledWith(EXP);
    }
    expect(cb.onClose).toHaveBeenCalledTimes(5);
  });

  it("a missing file offers only Delete — it cannot be posted", () => {
    renderMenu({ ...EXP, missing: true });
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Delete…"]);
    expect(screen.getByText("Missing file")).toBeInTheDocument();
  });

  it("Escape and an outside click close it", () => {
    const cb = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(cb.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ExportDeleteDialog", () => {
  it("asks, and confirms only on Delete", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ExportDeleteDialog exp={EXP} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText("Delete this export?")).toBeInTheDocument();
    expect(screen.getByText(/The file is removed from libi\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledWith(EXP);
  });
});
