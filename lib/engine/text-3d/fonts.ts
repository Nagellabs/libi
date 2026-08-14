export interface Bundled3DFont {
  family: string;
  file: string;
}

export const DEFAULT_3D_FONTS: Bundled3DFont[] = [
  { family: "Geist", file: "Geist-Regular.ttf" },
  { family: "Archivo Black", file: "ArchivoBlack-Regular.ttf" },
  { family: "Bungee", file: "Bungee-Regular.ttf" },
  { family: "Anton", file: "Anton-Regular.ttf" },
];

export const FALLBACK_3D_FONT = DEFAULT_3D_FONTS[0];

/**
 * Absolute on-disk path to a bundled 3D font. SERVER-ONLY (reads from disk via
 * `process.cwd()`). This module is also reachable from the browser render
 * bundle (esbuild) via the font-resolve graph, so it must NOT statically import
 * `node:path` — that fails to resolve for `platform: "browser"`. The browser
 * never CALLS this helper (it loads fonts by web URL, see
 * `text-3d/browser-deps.ts`), so a plain string join is safe here and keeps the
 * module browser-bundleable.
 */
export function bundledFontFilePath(file: string): string {
  return `${process.cwd()}/public/fonts/3d/${file}`;
}

export function bundledFontPath(family: string): string | null {
  const f = DEFAULT_3D_FONTS.find((d) => d.family.toLowerCase() === family.trim().toLowerCase());
  return f ? bundledFontFilePath(f.file) : null;
}

export function defaultFontFor(family: string): Bundled3DFont {
  return DEFAULT_3D_FONTS.find((d) => d.family.toLowerCase() === family.trim().toLowerCase()) ?? FALLBACK_3D_FONT;
}
