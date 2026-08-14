import fs from "fs";
import path from "path";

/**
 * Minimal glob resolver: supports a single `*` wildcard per path segment.
 * Used to match upstream archive folder names with floating version prefixes
 * (e.g., `ffmpeg-7.1-amd64-static/ffmpeg`).
 *
 * Returns the absolute path to the first match, or null if none found.
 */
export function resolveGlob(rootDir: string, pattern: string): string | null {
  const parts = pattern.split("/");
  let current = [rootDir];

  for (const seg of parts) {
    if (!seg.includes("*")) {
      current = current.map((c) => path.join(c, seg));
      continue;
    }
    const next: string[] = [];
    const re = new RegExp(
      "^" + seg.split("*").map(escapeRe).join(".*") + "$",
    );
    for (const dir of current) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (re.test(entry)) next.push(path.join(dir, entry));
      }
    }
    current = next;
  }

  for (const candidate of current) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
