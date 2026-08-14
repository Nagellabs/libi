import { bundledFontPath, bundledFontFilePath, FALLBACK_3D_FONT } from "@/lib/engine/text-3d/fonts";

export type FontResolution =
  | { kind: "file"; path: string; source: "uploaded" | "bundled" }
  | { kind: "faux"; reason: "no-file" | "unsupported-format" };

interface FontInput {
  fontFamily?: string;
  fontFileId?: string;
}

interface FileLike {
  id: string;
  filename: string;
  pieceId: string | null;
}

const REAL_EXTS = [".ttf", ".otf"];

export function resolve3DFont(
  input: FontInput,
  lookupFile: (id: string) => FileLike | null,
  localPath?: (pieceId: string | null, filename: string) => string,
): FontResolution {
  if (input.fontFileId) {
    const f = lookupFile(input.fontFileId);
    if (f) {
      const ok = REAL_EXTS.some((e) => f.filename.toLowerCase().endsWith(e));
      if (!ok) return { kind: "faux", reason: "unsupported-format" };
      const path = localPath ? localPath(f.pieceId, f.filename) : f.filename;
      return { kind: "file", path, source: "uploaded" };
    }
  }
  const fam = input.fontFamily?.split(",")[0]?.trim() ?? "";
  const bundled = fam ? bundledFontPath(fam) : null;
  if (bundled) return { kind: "file", path: bundled, source: "bundled" };
  // Default to REAL 3D: an unrecognized / unset family falls back to a bundled
  // font (real extrusion), NOT faux. Faux is reserved for the one case the user
  // genuinely opts into — an uploaded font in an unsupported format (above).
  return { kind: "file", path: bundledFontFilePath(FALLBACK_3D_FONT.file), source: "bundled" };
}

export function geometryCacheKey(path: string, text: string, depth: number, bevel: number): string {
  return `${path}|${text}|${depth}|${bevel}`;
}
