"use client";

import { useEffect, useRef, useState } from "react";
import type { Composition, Overlay } from "@/lib/engine/types";
import { registerCustomFont } from "@/lib/fonts/registry-client";

/** Collect the distinct fontFileIds referenced by text overlays. */
function pickFontFileIds(overlays: Overlay[]): string[] {
  const ids = new Set<string>();
  for (const o of overlays) {
    if (o.kind === "text" && o.fontFileId) ids.add(o.fontFileId);
  }
  return Array.from(ids);
}

/**
 * Registers every uploaded font referenced by a text overlay via the FontFace
 * API (idempotent, cached in `registry-client`). Returns a `version` counter
 * that bumps once a newly-registered font finishes loading so the player
 * repaints with the now-available family. Mirrors the shape of
 * `useOverlayImages` / `useOverlayCompiledFns`.
 */
export function useOverlayFonts(composition: Composition | null): { version: number } {
  const registered = useRef<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!composition) return;
    let cancelled = false;
    for (const fileId of pickFontFileIds(composition.overlays ?? [])) {
      if (registered.current.has(fileId)) continue;
      registered.current.add(fileId);
      registerCustomFont(fileId).then(() => {
        if (!cancelled) setVersion((v) => v + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [composition]);

  return { version };
}
