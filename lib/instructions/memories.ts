import fs from "node:fs";
import path from "node:path";
import { getLibiMemoriesPath } from "@/lib/libi-home";

/** Same cap the old settings system prompt had. */
export const MEMORIES_MAX_CHARS = 8000;

/** Read the memories file. Missing/unreadable file reads as "". */
export function readMemories(): string {
  try {
    return fs.readFileSync(getLibiMemoriesPath(), "utf-8");
  } catch {
    return "";
  }
}

/** Replace the whole memories file. Passing "" is valid and clears it. */
export function writeMemories(content: string): void {
  if (content.length > MEMORIES_MAX_CHARS) {
    throw new Error(`Memories exceed ${MEMORIES_MAX_CHARS} chars`);
  }
  const filePath = getLibiMemoriesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Append one memory, blank-line separated. Returns the new full content.
 *  Read-then-write with no lock — concurrent writers are last-write-wins,
 *  acceptable for a low-frequency preferences file. */
export function appendMemories(content: string): string {
  const existing = readMemories().trimEnd();
  const entry = content.trim();
  const next = existing.length > 0 ? `${existing}\n\n${entry}\n` : `${entry}\n`;
  writeMemories(next);
  return next;
}
