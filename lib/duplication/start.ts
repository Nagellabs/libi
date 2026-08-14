import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { resolveCopyName } from "./copy-name";

/**
 * Create the shell `pieces` row a piece-duplication will fill. Resolves the
 * default copy name from the source's name when `name` is omitted. Returns the
 * new piece id + final name. Throws `piece_not_found` if the source is missing.
 */
export function createDuplicatePieceShell(
  sourcePieceId: string,
  opts: { name?: string; folderId?: string | null },
): { newPieceId: string; name: string } {
  const db = getDb();
  const src = db.select().from(pieces).where(eq(pieces.id, sourcePieceId)).get();
  if (!src) throw new Error("piece_not_found");
  const existing = db.select({ name: pieces.name }).from(pieces).all().map((r) => r.name);
  const name = opts.name?.trim() || resolveCopyName(src.name, existing);
  const folderId = opts.folderId === undefined ? src.folderId : opts.folderId;
  const [shell] = db.insert(pieces).values({ name, folderId }).returning().all();
  return { newPieceId: shell.id, name };
}
