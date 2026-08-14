import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { getOpenedPieceId } from "@/lib/editor-state";
import { dropProxyFile } from "./lifecycle";

export interface ProxyEntry {
  fileId: string;
  bytes: number;
  /** Unix seconds. Older = evicted first. */
  generatedAt: number;
  /** Attached to a piece the user currently has open. Protected from eviction. */
  inUse: boolean;
}

/** Default disk budget for ready proxies — 4 GB. */
export const DEFAULT_PROXY_BYTE_BUDGET = 4 * 1024 * 1024 * 1024;

/**
 * Return the fileIds to evict (in order) to bring the total proxy
 * footprint at or below `byteBudget`. Prefers evicting non-in-use
 * oldest first; only evicts in-use entries as a last resort.
 */
export function selectProxiesToEvict(entries: ProxyEntry[], byteBudget: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= byteBudget) return [];

  const sorted = [...entries].sort((a, b) => {
    // In-use entries sink to the end (evicted last).
    if (a.inUse !== b.inUse) return a.inUse ? 1 : -1;
    // Then by age: older first.
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

export interface EvictOptions {
  /** Defaults to DEFAULT_PROXY_BYTE_BUDGET (4 GB). */
  byteBudget?: number;
  /** Defaults to `getLibiStorageDir()`. */
  storageBaseDir?: string;
  /** Set of fileIds protected from eviction (currently open in UI). Defaults to empty. */
  inUseFileIds?: Set<string>;
}

/**
 * Enumerate ready proxies, pass through `selectProxiesToEvict`, and drop
 * each chosen one via `dropProxyFile`. Called after every successful
 * proxy generation. Silent + cheap when under budget.
 *
 * Resolves the in-use set lazily so the runner doesn't have to know about
 * `editor-state`. Errors from individual statSync calls skip that entry
 * rather than aborting the sweep.
 */
export function evictProxiesIfOverBudget(opts: EvictOptions = {}): void {
  const byteBudget = opts.byteBudget ?? DEFAULT_PROXY_BYTE_BUDGET;
  const storageBaseDir = opts.storageBaseDir ?? getLibiStorageDir();
  const inUse = opts.inUseFileIds ?? resolveInUseFileIds();

  const db = getDb();
  const readyRows = db
    .select()
    .from(files)
    .where(eq(files.proxyStatus, "ready"))
    .all();
  if (readyRows.length === 0) return;

  const entries: ProxyEntry[] = [];
  for (const row of readyRows) {
    if (!row.proxyFilename) continue;
    const proxyPath = path.join(
      storageBaseDir,
      row.pieceId ?? "_global",
      row.proxyFilename,
    );
    let bytes = 0;
    try {
      bytes = fs.statSync(proxyPath).size;
    } catch {
      continue;
    }
    entries.push({
      fileId: row.id,
      bytes,
      generatedAt: Math.floor((row.proxyGeneratedAt?.getTime() ?? 0) / 1000),
      inUse: inUse.has(row.id),
    });
  }

  const toEvict = selectProxiesToEvict(entries, byteBudget);
  for (const fileId of toEvict) {
    const entry = entries.find((e) => e.fileId === fileId);
    if (entry) {
      logger.info(
        {
          fileId,
          event: "evict",
          bytes: entry.bytes,
          ageMs: Date.now() - entry.generatedAt * 1000,
        },
        "proxy.evict",
      );
    }
    try {
      dropProxyFile(fileId, "lru");
    } catch (err) {
      logger.warn({ err, fileId }, "proxy.evict.drop_failed");
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
      "proxy.evict.in_use_resolution_failed",
    );
    return new Set();
  }
}
