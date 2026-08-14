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
});
