// electron/context-menu.ts
//
// The main window's right-click menu. Electron draws none of its own, so
// nothing in the desktop app could be pasted with a right-click — most visibly
// a setup terminal's key prompt on Windows, where right-click paste is what
// people reach for. An editable target gets Cut / Copy / Paste / Select All,
// and a plain text selection gets Copy; anything else gets no menu.
//
// The inline terminal is editable too, but only in name: on right-click xterm
// moves its focused helper textarea under the pointer and fills it with the
// terminal's selection. Paste there lands in the terminal and Copy copies that
// selection, while Cut would only copy and Select All would select the hidden
// textarea — so the terminal gets Copy and Paste alone. It is recognised by
// that textarea having focus, which xterm gives it while the renderer handles
// the right-click, before this event reaches the main process.
import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

type MenuParams = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">;

/** xterm's own class for the textarea that takes its keyboard and clipboard input. */
const TERMINAL_FOCUSED = "document.activeElement?.classList.contains('xterm-helper-textarea') === true";

export function contextMenuTemplate(params: MenuParams, target: { terminal: boolean } = { terminal: false }): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  if (params.isEditable && target.terminal) {
    return [
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
    ];
  }
  if (params.isEditable) {
    return [
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    ];
  }
  if (params.selectionText.trim()) return [{ role: "copy", enabled: flags.canCopy }];
  return [];
}

export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    void (async () => {
      const terminal = params.isEditable
        ? await win.webContents.executeJavaScript(TERMINAL_FOCUSED).then(
            (focused: unknown) => focused === true,
            () => false,
          )
        : false;
      const template = contextMenuTemplate(params, { terminal });
      if (template.length > 0 && !win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: win });
    })();
  });
}
