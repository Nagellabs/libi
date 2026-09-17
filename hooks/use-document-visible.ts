"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the document is currently visible — `document.visibilityState`,
 * kept live through `visibilitychange`.
 *
 * For gating polls: React Query pauses a `refetchInterval` while the window is
 * unFOCUSED, but a visible-yet-unfocused window still polls, and a hidden tab
 * with focus semantics of its own (a background Electron window, a minimised
 * app) may not. Reading visibility directly is the honest signal for "nobody
 * can see this".
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getSnapshot(): boolean {
  return document.visibilityState === "visible";
}

function getServerSnapshot(): boolean {
  return true;
}
