import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  /** Show a file in the OS file manager (Finder / Explorer / xdg). */
  revealFile: (absPath: string) => ipcRenderer.invoke("libi:reveal-file", absPath),
  /** Open a native directory-picker dialog. Returns the chosen absolute path or null. */
  pickDirectory: (initialPath?: string) =>
    ipcRenderer.invoke("libi:pick-directory", initialPath ?? null),
  /** Window controls (used by the in-app TopBar on Windows/Linux). */
  windowMinimize: () => ipcRenderer.invoke("libi:window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("libi:window-maximize"),
  windowClose: () => ipcRenderer.invoke("libi:window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("libi:window-is-maximized") as Promise<boolean>,
  /**
   * Ask Electron main for a native "Publish … to the public catalog?" dialog
   * (electron/confirm-publish.ts). True only when the user pressed Publish;
   * "refused" when the dialog won't show these arguments.
   */
  confirmPublish: (args: { templateName: string; catalogHost: string }) =>
    ipcRenderer.invoke("libi:confirm-publish", args) as Promise<boolean | "refused">,
  /**
   * Put an export FILE on the OS clipboard (electron/copy-file.ts). True when
   * the file is there; false when main refused the path or the platform can't
   * (the page then copies the path instead).
   */
  copyFileToClipboard: (absPath: string) => ipcRenderer.invoke("libi:copy-file", absPath) as Promise<boolean>,
});
