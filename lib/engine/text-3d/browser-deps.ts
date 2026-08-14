/** Production `BuildTextThreeDeps` for the BROWSER (preview hook). Resolves the
 *  overlay's font to a web URL (/fonts/3d/<file> for bundled, /api/files/by-id/…
 *  for uploaded), parses it via fetch+opentype, and builds per-glyph extruded
 *  meshes (premium) or stacked faux planes (fallback). three is lazy-imported. */

import type { TextOverlay } from "@/lib/engine/types";
import type { BuildTextThreeDeps, LoadedFontLike } from "@/lib/engine/text-3d/build-text-three";
import type { FontResolution } from "@/lib/engine/text-3d/font-resolve";
import { DEFAULT_3D_FONTS } from "@/lib/engine/text-3d/fonts";
import { loadFontFromUrl, glyphShapesFor, buildExtrudedMesh } from "@/lib/engine/text-3d/extrude";
import { buildFauxText } from "@/lib/engine/text-3d/faux";
import { makeCanvasTextClass } from "@/lib/engine/canvas-text";

const REAL_EXTS = [".ttf", ".otf"];

/** Bundled family → web URL under /fonts/3d/. Returns null for an unknown family. */
function bundledFontUrl(family: string): string | null {
  const f = DEFAULT_3D_FONTS.find((d) => d.family.toLowerCase() === family.trim().toLowerCase());
  return f ? `/fonts/3d/${f.file}` : null;
}

/** Browser-side font resolution: maps a TextOverlay to a fetchable URL or a faux
 *  fallback. Mirrors resolve3DFont's precedence (uploaded file → bundled family
 *  → faux) but yields a URL instead of a filesystem path. `lookupFilename`
 *  resolves an uploaded fontFileId to its filename so the extension can gate
 *  unsupported formats. */
export function resolve3DFontUrl(
  overlay: TextOverlay,
  lookupFilename?: (fileId: string) => string | null,
): FontResolution {
  if (overlay.fontFileId) {
    const name = lookupFilename?.(overlay.fontFileId) ?? "";
    const ok = name ? REAL_EXTS.some((e) => name.toLowerCase().endsWith(e)) : true;
    if (!ok) return { kind: "faux", reason: "unsupported-format" };
    return { kind: "file", path: `/api/files/by-id/${overlay.fontFileId}/content`, source: "uploaded" };
  }
  const fam = overlay.fontFamily?.split(",")[0]?.trim() ?? "";
  const url = fam ? bundledFontUrl(fam) : null;
  if (url) return { kind: "file", path: url, source: "bundled" };
  // Default to REAL 3D: unrecognized / unset family → a bundled font (real
  // extrusion), not faux. Faux only for an uploaded unsupported format (above).
  return { kind: "file", path: `/fonts/3d/${DEFAULT_3D_FONTS[0].file}`, source: "bundled" };
}

/** Build the browser deps. `lookupFilename` (optional) lets uploaded-font
 *  extension gating work; without it, an uploaded fontFileId is trusted. */
export function makeBrowserTextThreeDeps(
  lookupFilename?: (fileId: string) => string | null,
): BuildTextThreeDeps {
  return {
    resolveFont: (overlay) => resolve3DFontUrl(overlay, lookupFilename),
    loadFont: (url) => loadFontFromUrl(url) as unknown as Promise<LoadedFontLike>,
    buildGlyphMesh: (THREE, font, glyph, size, opts, cacheKey) => {
      // font here IS an opentype.Font (loadFontFromUrl); glyphShapesFor needs it.
      const shapes = glyphShapesFor(font as unknown as Parameters<typeof glyphShapesFor>[0], glyph, size);
      if (shapes.length === 0) return new THREE.Group(); // unmappable glyph → empty
      return buildExtrudedMesh(THREE, shapes, opts, cacheKey);
    },
    buildGlyphFaux: (THREE, glyph, opts) => {
      const CanvasText = makeCanvasTextClass(THREE);
      return buildFauxText(THREE, CanvasText, { ...opts, content: glyph });
    },
    importThree: () => import("three"),
  };
}
