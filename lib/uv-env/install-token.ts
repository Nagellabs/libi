import fs from "fs";
import path from "path";
import { getLibiHome } from "@/lib/libi-home";

/** Read a one-line token file under LIBI_HOME. Returns null on any
 *  filesystem error (missing file, permission, garbage). */
export function readInstallToken(filename: string): string | null {
  try {
    return fs
      .readFileSync(path.join(getLibiHome(), filename), "utf-8")
      .trim();
  } catch {
    return null;
  }
}

/** Write a one-line token file under LIBI_HOME. Creates parent dirs.
 *  Single trailing newline so `cat <file>` prints cleanly. */
export function writeInstallToken(filename: string, signature: string): void {
  const full = path.join(getLibiHome(), filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, signature + "\n");
}

/** True iff the on-disk token equals the expected signature. */
export function isTokenCurrent(filename: string, signature: string): boolean {
  return readInstallToken(filename) === signature;
}
