// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PickFolderClientResult } from "@/lib/shell/client";

let pickResult: PickFolderClientResult = { status: "cancelled" };
const pickFolder = vi.fn<(p?: string) => Promise<PickFolderClientResult>>(async () => pickResult);
vi.mock("@/lib/shell/client", () => ({ pickFolder: (p?: string) => pickFolder(p) }));

import { FolderPickerField } from "@/components/agents-page/skills/folder-picker-field";

function Harness({ onSubmit = vi.fn(), error = null as string | null }) {
  const [value, setValue] = useState("");
  return <FolderPickerField value={value} onChange={setValue} onSubmit={onSubmit} submitLabel="Add" error={error} />;
}

beforeEach(() => {
  pickFolder.mockClear();
  pickResult = { status: "cancelled" };
});

describe("FolderPickerField", () => {
  it("picking fills the field; the submit button is enabled only with a value", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const add = screen.getByRole("button", { name: /^add$/i });
    expect(add).toBeDisabled();
    pickResult = { status: "picked", path: "/Users/me/proj" };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /choose folder/i })); });
    expect(screen.getByRole("textbox")).toHaveValue("/Users/me/proj");
    expect(pickFolder).toHaveBeenCalledWith(undefined);
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it("a pasted path works without the dialog, and Enter submits", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/pasted" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(pickFolder).not.toHaveBeenCalled();
  });
  it("passes the current value as the dialog's start folder, and is disabled while the dialog is open", async () => {
    let release!: (r: PickFolderClientResult) => void;
    pickFolder.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/start" } });
    const choose = screen.getByRole("button", { name: /choose folder/i });
    fireEvent.click(choose);
    expect(pickFolder).toHaveBeenCalledWith("/start");
    expect(choose).toBeDisabled();
    await act(async () => { release({ status: "cancelled" }); });
    expect(choose).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("/start");
  });
  it("unavailable shows the paste hint; busy says a dialog is open; an error prop renders", async () => {
    pickResult = { status: "unavailable", reason: "zenity is not installed" };
    const { rerender } = render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /choose folder/i })); });
    expect(screen.getByText("Couldn't open a folder dialog here — paste the path instead.")).toBeInTheDocument();
    pickResult = { status: "busy" };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /choose folder/i })); });
    expect(screen.getByText("A folder dialog is already open.")).toBeInTheDocument();
    rerender(<Harness error="That folder doesn't exist." />);
    expect(screen.getByRole("alert")).toHaveTextContent("That folder doesn't exist.");
  });
  it("every button has cursor-pointer", () => {
    render(<Harness />);
    for (const b of screen.getAllByRole("button")) expect(b).toHaveClass("cursor-pointer");
  });
  it("ignores a pick that resolves after the field unmounts — it must not call the parent's setter", async () => {
    let release!: (r: PickFolderClientResult) => void;
    pickFolder.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const onChange = vi.fn();
    const { unmount } = render(<FolderPickerField value="" onChange={onChange} onSubmit={vi.fn()} submitLabel="Add" />);
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    expect(pickFolder).toHaveBeenCalled();
    unmount();
    await act(async () => { release({ status: "picked", path: "/late/pick" }); });
    expect(onChange).not.toHaveBeenCalled();
  });
});
