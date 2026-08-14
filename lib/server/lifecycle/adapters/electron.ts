// lib/server/lifecycle/adapters/electron.ts
import type { BrowserWindow } from "electron";
import type { LifecycleAdapter, LifecycleEvent } from "../types";

export function electronAdapter(splash: BrowserWindow): LifecycleAdapter {
  return {
    onEvent(e: LifecycleEvent) {
      if (!splash.isDestroyed()) splash.webContents.send("lifecycle", e);
    },
  };
}
