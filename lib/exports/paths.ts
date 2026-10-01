import path from "node:path";
import { getStorage } from "@/lib/storage";

/** A piece's exports live in `<storage>/<pieceId>/exports/` (spec §A2). */
export const EXPORTS_DIR = "exports";

/** `exports/<fileName>` — always forward slashes, whatever the OS. */
export function relPathFor(fileName: string): string {
  return `${EXPORTS_DIR}/${fileName}`;
}

/** Absolute path of a piece's exports folder (it may not exist yet). */
export async function exportsDirFor(pieceId: string): Promise<string> {
  return (await getStorage()).localPath(pieceId, EXPORTS_DIR);
}

/** Absolute path of an export file from its stored `rel_path`. Containment-checked by the storage layer. */
export async function absoluteExportPath(pieceId: string, relPath: string): Promise<string> {
  return (await getStorage()).localPath(pieceId, relPath);
}

/** `Summer promo.mp4` → `Summer promo`. */
export function fileStem(fileName: string): string {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}
