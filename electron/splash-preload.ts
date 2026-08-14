import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/**
 * RC-G: the splash window runs with `nodeIntegration:false, contextIsolation:true,
 * sandbox:true` (like the main window), so splash.html can no longer
 * `require("electron")`. This preload is the only bridge between the sandboxed
 * splash renderer and the main process — it exposes exactly the two IPC channels
 * the splash needs: receiving Category A/B lifecycle progress events, and asking
 * the app to quit from the fatal-error pane.
 */
contextBridge.exposeInMainWorld("splashAPI", {
  /** Subscribe to Category A/B lifecycle progress events. Returns an unsubscribe fn. */
  onLifecycle: (callback: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("lifecycle", listener);
    return () => ipcRenderer.removeListener("lifecycle", listener);
  },
  /** Quit the whole app (used by the fatal-error "Quit libi" button). */
  quit: () => ipcRenderer.send("splash-quit"),
});
