"use client";

import { createContext, useContext } from "react";
import type { OverlayEditStore } from "./overlay-edit-store";

const OverlayEditStoreContext = createContext<OverlayEditStore | null>(null);
export const OverlayEditStoreProvider = OverlayEditStoreContext.Provider;

/** Access the overlay edit store owned by PreviewSurface. Throws if used
 *  outside the provider (a programming error). */
export function useOverlayEditStore(): OverlayEditStore {
  const s = useContext(OverlayEditStoreContext);
  if (!s) throw new Error("useOverlayEditStore must be used within OverlayEditStoreProvider");
  return s;
}
