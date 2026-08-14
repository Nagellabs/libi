import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { getOpenedPieceId } from "@/lib/editor-state";
import { dropFilmstripFile } from "./lifecycle";

export interface FilmstripEntry {
  fileId: string;
  bytes: number;
  /** Unix seconds. Older = evicted first. */
  generatedAt: number;
  /** Attached to a piece the user currently has open. Protected from eviction. */
  inUse: boolean;
}

/** Default disk budget for ready filmstrip sprites — 1 GB (sprites are tiny). */
export const DEFAULT_FILMSTRIP_BYTE_BUDGET = 1 * 1024 * 1024 * 1024;

/**
 * Return the fileIds to evict (in order) to bring the total filmstrip
 * footprint at or below `byteBudget`. Prefers evicting non-in-use oldest
 * first; only evicts in-use entries as a last resort. Pure.
 */
export function selectFilmstripsToEvict(
  entries: FilmstripEntry[],
  byteBudget: number,
): string[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= byteBudget) return [];

  const sorted = [...entries].sort((a, b) => {
    if (a.inUse !== b.inUse) return a.inUse ? 1 : -1;
    return a.generatedAt - b.generatedAt;
  });

  const toEvict: string[] = [];
  let remaining = total;
  for (const entry of sorted) {
    if (remaining <= byteBudget) break;
    toEvict.push(entry.fileId);
    remaining -= entry.bytes;
  }
  return toEvict;
}

export interface FilmstripEvictOptions {
  /** Defaults to DEFAULT_FILMSTRIP_BYTE_BUDGET (1 GB). */
  byteBudget?: number;
  /** Defaults to `getLibiStorageDir()`. */
  storageBaseDir?: string;
  /** fileIds protected from eviction (currently open in UI). Defaults to resolved opened piece. */
  inUseFileIds?: Set<string>;
}

/**
 * Enumerate ready filmstrips, pass through `selectFilmstripsToEvict`, and drop
 * each chosen one via `dropFilmstripFile`. Called after every successful
 * filmstrip generation. Silent + cheap when under budget.
 */
export function evictFilmstripsIfOverBudget(opts: FilmstripEvictOptions = {}): void {
  const byteBudget = opts.byteBudget ?? DEFAULT_FILMSTRIP_BYTE_BUDGET;
  const storageBaseDir = opts.storageBaseDir ?? getLibiStorageDir();
  const inUse = opts.inUseFileIds ?? resolveInUseFileIds();

  const db = getDb();
  const readyRows = db
    .select()
    .from(files)
    .where(eq(files.filmstripStatus, "ready"))
    .all();
  if (readyRows.length === 0) return;

  const entries: FilmstripEntry[] = [];
  for (const row of readyRows) {
    if (!row.filmstripFilename) continue;
    const filmstripPath = path.join(
      storageBaseDir,
      row.pieceId ?? "_global",
      row.filmstripFilename,
    );
    let bytes = 0;
    try {
      bytes = fs.statSync(filmstripPath).size;
    } catch {
      continue;
    }
    entries.push({
      fileId: row.id,
      bytes,
      generatedAt: Math.floor((row.filmstripGeneratedAt?.getTime() ?? 0) / 1000),
      inUse: inUse.has(row.id),
    });
  }

  const toEvict = selectFilmstripsToEvict(entries, byteBudget);
  for (const fileId of toEvict) {
    const entry = entries.find((e) => e.fileId === fileId);
    if (entry) {
      logger.info(
        {
          fileId,
          event: "evict",
          bytes: entry.bytes,
          ageMs: Date.now() - entry.generatedAt * 1000,
          tag: "filmstrip",
        },
        "filmstrip.evict",
      );
    }
    try {
      dropFilmstripFile(fileId, "lru");
    } catch (err) {
      logger.warn({ err, fileId }, "filmstrip.evict.drop_failed");
    }
  }
}

/**
 * Resolve the set of fileIds belonging to the currently-opened piece.
 * Silent on failure (no opened piece, no DB, etc.).
 */
function resolveInUseFileIds(): Set<string> {
  try {
    const pieceId = getOpenedPieceId();
    if (!pieceId) return new Set();
    const db = getDb();
    const rows = db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.pieceId, pieceId))
      .all();
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "filmstrip.evict.in_use_resolution_failed",
    );
    return new Set();
  }
}
