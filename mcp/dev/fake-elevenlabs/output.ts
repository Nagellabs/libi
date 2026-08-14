import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";

/**
 * Resolve where a placeholder file is written. Faithful to elevenlabs-mcp's
 * make_output_path EXCEPT the default: instead of ~/Desktop we write to a temp
 * dir under the libi home so test runs never pollute the user's Desktop.
 */
export function resolveOutputDir(outputDirectory?: string | null): string {
  const dir = outputDirectory && isAbsolute(outputDirectory)
    ? outputDirectory
    : join(getLibiHome(), "test-mode", "elevenlabs-out");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Faithful to elevenlabs-mcp make_output_file: `{tool}_{text[:5]}_{ts}.{ext}`. */
export function makeOutputFileName(tool: string, text: string, ext: string): string {
  const id = text.slice(0, 5).replace(/ /g, "_");
  return `${tool}_${id}_${stamp()}.${ext}`;
}
