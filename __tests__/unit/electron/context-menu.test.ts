import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The desktop app's right-click menu. Electron shows none by default, which left
 * a Windows user no way to right-click paste a provider key into a setup
 * terminal. `electron` is mocked: what is under test is which menu a target
 * gets, and that the window pops it.
 */
const h = vi.hoisted(() => ({ popup: vi.fn(), buildFromTemplate: vi.fn() }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: h.buildFromTemplate } }));

import { contextMenuTemplate, installContextMenu } from "../../../electron/context-menu";

const allFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: true, canEditRichly: false };

function params(over: Partial<Parameters<typeof contextMenuTemplate>[0]> = {}) {
  return { isEditable: false, selectionText: "", editFlags: allFlags, ...over } as Parameters<typeof contextMenuTemplate>[0];
}

const roles = (template: ReturnType<typeof contextMenuTemplate>) => template.map((item) => item.role ?? item.type);

beforeEach(() => {
  h.popup.mockReset();
  h.buildFromTemplate.mockReset();
  h.buildFromTemplate.mockImplementation(() => ({ popup: h.popup }));
});

describe("contextMenuTemplate", () => {
  it("a text field gets Cut, Copy, Paste and Select All, each enabled as Chromium says", () => {
    const template = contextMenuTemplate(params({ isEditable: true, editFlags: { ...allFlags, canCut: false, canCopy: false } }));
    expect(roles(template)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(template.find((item) => item.role === "paste")?.enabled).toBe(true);
    expect(template.find((item) => item.role === "cut")?.enabled).toBe(false);
    expect(template.find((item) => item.role === "copy")?.enabled).toBe(false);
  });

  it("the terminal gets Copy and Paste only — Cut and Select All would act on xterm's hidden textarea", () => {
    const template = contextMenuTemplate(params({ isEditable: true, editFlags: { ...allFlags, canCopy: false } }), { terminal: true });
    expect(roles(template)).toEqual(["copy", "paste"]);
    expect(template[0].enabled).toBe(false);
    expect(template[1].enabled).toBe(true);
  });

  it("a plain text selection gets Copy only, and nothing selected gets no menu", () => {
    expect(roles(contextMenuTemplate(params({ selectionText: "a line of chat" })))).toEqual(["copy"]);
    expect(contextMenuTemplate(params({ selectionText: "  \n " }))).toEqual([]);
    expect(contextMenuTemplate(params())).toEqual([]);
  });
});

describe("installContextMenu", () => {
  function fakeWindow(terminalFocused: Promise<unknown> = Promise.resolve(false)) {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const executeJavaScript = vi.fn(() => terminalFocused);
    const win = {
      isDestroyed: vi.fn(() => false),
      webContents: { on: vi.fn((event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn)), executeJavaScript },
    };
    installContextMenu(win as never);
    const rightClick = (p: Parameters<typeof contextMenuTemplate>[0]) => handlers.get("context-menu")!({}, p);
    return { win, executeJavaScript, rightClick };
  }

  it("pops the full menu over the window for a text field", async () => {
    const { win, rightClick } = fakeWindow();
    rightClick(params({ isEditable: true }));
    await vi.waitFor(() => expect(h.popup).toHaveBeenCalledWith({ window: win }));
    expect(roles(h.buildFromTemplate.mock.calls[0][0])).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
  });

  it("asks the page whether xterm's textarea has focus, and gives the terminal Copy and Paste", async () => {
    const { executeJavaScript, rightClick } = fakeWindow(Promise.resolve(true));
    rightClick(params({ isEditable: true }));
    await vi.waitFor(() => expect(h.popup).toHaveBeenCalled());
    expect(executeJavaScript.mock.calls[0]).toEqual([expect.stringContaining("xterm-helper-textarea")]);
    expect(roles(h.buildFromTemplate.mock.calls[0][0])).toEqual(["copy", "paste"]);
  });

  it("a page that can't answer still gets the text-field menu", async () => {
    const { rightClick } = fakeWindow(Promise.reject(new Error("render frame gone")));
    rightClick(params({ isEditable: true }));
    await vi.waitFor(() => expect(h.popup).toHaveBeenCalled());
    expect(roles(h.buildFromTemplate.mock.calls[0][0])).toContain("selectAll");
  });

  it("builds nothing where there is nothing to offer, and never asks the page about a non-editable target", async () => {
    const { executeJavaScript, rightClick } = fakeWindow();
    rightClick(params());
    await new Promise((r) => setTimeout(r, 0));
    expect(h.buildFromTemplate).not.toHaveBeenCalled();
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("pops nothing over a window closed while the page was answering", async () => {
    const { win, rightClick } = fakeWindow();
    win.isDestroyed.mockReturnValue(true);
    rightClick(params({ isEditable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.popup).not.toHaveBeenCalled();
  });
});
