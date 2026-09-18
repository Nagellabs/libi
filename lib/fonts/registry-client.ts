"use client";

import { cssFamilyForFontFile } from "@/lib/fonts/family";
import type { Overlay } from "@/lib/engine/types";

/** `null` once the face loaded; otherwise why it didn't. */
type LoadOutcome = string | null;

const loaded = new Map<string, Promise<LoadOutcome>>();

/** A font load still pending after this long counts as failed: the export
 *  render page awaits these before its first frame, and a stalled request
 *  must not hang the export. The text renders in the fallback face and the
 *  fileId is reported like any other failure. */
export const FONT_LOAD_TIMEOUT_MS = 12_000;

/**
 * Register an uploaded font for canvas/DOM use via the FontFace API, keyed by
 * fileId. Idempotent + cached: the same fileId loads once. Best-effort — it
 * never rejects: resolves `null` when the face loaded, or the failure reason
 * (rendering then falls back to the default family).
 */
export function registerCustomFont(fileId: string): Promise<LoadOutcome> {
  let p = loaded.get(fileId);
  if (p) return p;
  const family = cssFamilyForFontFile(fileId);
  const url = `/api/files/by-id/${fileId}/content`;
  p = (async () => {
    try {
      const face = new FontFace(family, `url(${url})`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("font load timed out")), FONT_LOAD_TIMEOUT_MS);
      });
      try {
        await Promise.race([face.load(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      (document as Document & { fonts: FontFaceSet }).fonts.add(face);
      return null;
    } catch (err) {
      // swallow — preview falls back to the shorthand's named family
      return err instanceof Error ? err.message : String(err);
    }
  })();
  loaded.set(fileId, p);
  return p;
}

/**
 * Register every uploaded font a text overlay references and wait for all of
 * them. Returns the ones that failed, with why. The export render page awaits
 * this before its first frame — it used to load only the bundled faces, so an
 * uploaded font exported in the default face (QA 2026-09-18 recheck N5).
 */
export async function loadOverlayFonts(
  overlays: Overlay[],
): Promise<Array<{ fontFileId: string; reason: string }>> {
  const ids = new Set<string>();
  for (const o of overlays) {
    if (o.kind === "text" && o.fontFileId) ids.add(o.fontFileId);
  }
  const results = await Promise.all(
    Array.from(ids, async (fontFileId) => ({ fontFileId, reason: await registerCustomFont(fontFileId) })),
  );
  return results.flatMap(({ fontFileId, reason }) => (reason === null ? [] : [{ fontFileId, reason }]));
}

/** True once a fileId's FontFace has been added (or attempted). */
export function isFontRegistered(fileId: string): boolean {
  return loaded.has(fileId);
}
