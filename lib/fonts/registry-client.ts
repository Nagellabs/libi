"use client";

import { cssFamilyForFontFile } from "@/lib/fonts/family";

const loaded = new Map<string, Promise<void>>();

/**
 * Register an uploaded font for canvas/DOM use via the FontFace API, keyed by
 * fileId. Idempotent + cached: the same fileId loads once. Best-effort — a
 * failed load resolves (rendering falls back to the default family).
 */
export function registerCustomFont(fileId: string): Promise<void> {
  let p = loaded.get(fileId);
  if (p) return p;
  const family = cssFamilyForFontFile(fileId);
  const url = `/api/files/by-id/${fileId}/content`;
  p = (async () => {
    try {
      const face = new FontFace(family, `url(${url})`);
      await face.load();
      (document as Document & { fonts: FontFaceSet }).fonts.add(face);
    } catch {
      // swallow — preview falls back to the shorthand's named family
    }
  })();
  loaded.set(fileId, p);
  return p;
}

/** True once a fileId's FontFace has been added (or attempted). */
export function isFontRegistered(fileId: string): boolean {
  return loaded.has(fileId);
}
